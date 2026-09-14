#!/usr/bin/env node
// cnb-auto-deliver — deliver open CNB Developer PRs to GitHub automatically.
//
// Called by the CNB `pull_request.target` pipeline (trusted: config from the
// target branch main), by the `api_trigger_deliver` pipeline (manual/remote
// delivery), and runnable locally for testing. For every OPEN CNB pull
// request whose head branch starts with `ai/cnb-dev/` and whose base is
// `main`:
//   1. fetch the head branch from the CNB repo
//   2. push it to GitHub under the same branch name (fast-forward, no force)
//   3. create the GitHub PR if it does not exist yet (idempotent)
//   4. best-effort close the CNB PR (delivery moved to GitHub; non-fatal)
//
// Auth (env): CNB_TOKEN (CNB API), GITHUB_SYNC_TOKEN (GitHub: Contents RW +
// Pull requests RW on the target repo). Tokens are never printed or written.
//
// Output: human-readable progress lines + a final JSON summary on stdout.
// When DELIVER_REPORT_FILE is set, the JSON summary is also written there
// (the pipeline uploads it as a build attachment for run-to-run evidence).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

// ── Pure selection logic (unit-tested in scripts/__tests__/cnb-auto-deliver.test.mjs) ──

/**
 * CNB's PR API returns full refs ("refs/heads/ai/cnb-dev/x"), not bare
 * branch names. PRI-785: the filter used to match bare names, never hit,
 * and the pipeline exited green with zero deliveries. Every ref read from
 * the CNB API MUST go through normRef before comparison.
 */
export function normRef(ref) {
  return String(ref ?? "").replace(/^refs\/heads\//, "");
}

export function selectDeliverablePRs(pulls, { headPrefix = "ai/cnb-dev/", base = "main" } = {}) {
  return (Array.isArray(pulls) ? pulls : []).filter(
    (p) => normRef(p?.head?.ref).startsWith(headPrefix) && normRef(p?.base?.ref) === base,
  );
}

// ── Plumbing ─────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[auto-deliver] ${msg}\n`);
}
function die(msg, nextAction) {
  log(`ERROR: ${msg}`);
  log(`nextAction: ${nextAction || ""}`);
  process.exit(1);
}
function redact(s) {
  return String(s).replace(/gh[pousr]_[A-Za-z0-9_]{8,}/g, "ghp_REDACTED").replace(/github_pat_[A-Za-z0-9_]{8,}/g, "github_pat_REDACTED");
}
async function api(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, data };
}

function writeReport(summary) {
  const file = process.env.DELIVER_REPORT_FILE;
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
    log(`report written: ${file}`);
  } catch (e) {
    log(`WARN: could not write report file ${file}: ${e.message}`);
  }
}

async function main() {
  const CNB_API = process.env.CNB_API || "https://api.cnb.cool";
  const CNB_TOKEN = process.env.CNB_TOKEN;
  const GH_TOKEN = process.env.GITHUB_SYNC_TOKEN;
  const GH_REPO = process.env.GITHUB_REPO || "csuzngjh/principles";
  const CNB_REPO = process.env.CNB_REPO || "csuzngjh/principles";
  const CNB_WEB = process.env.CNB_WEB || "https://cnb.cool";
  const HEAD_PREFIX = process.env.DELIVER_HEAD_PREFIX || "ai/cnb-dev/";
  const BASE = process.env.DELIVER_BASE || "main";

  if (!CNB_TOKEN) die("CNB_TOKEN is not set", "the CNB pipeline injects it automatically; for local runs export it");
  if (!GH_TOKEN) die("GITHUB_SYNC_TOKEN is not set", "check pd-secrets@main/cnb-github-bridge.yml allow_events and key names (runbook §4.4.1)");

  // 1) open CNB PRs. page_size (not per_page) is CNB's parameter, and
  // base_ref=main filters server-side; the client-side filter below still
  // guards against API drift.
  const list = await api(CNB_API, CNB_TOKEN, "GET",
    `/${CNB_REPO}/-/pulls?state=open&page_size=50&base_ref=${encodeURIComponent(BASE)}`);
  if (!list.ok || !Array.isArray(list.data)) {
    die(`cannot list CNB pull requests: HTTP ${list.status} ${redact(JSON.stringify(list.data)).slice(0, 200)}`,
      "check CNB_TOKEN scopes");
  }

  // PRI-785 observability: enumerate what CNB reported BEFORE filtering.
  // The silent zero-match exit used to look like a healthy green run.
  log(`open CNB PRs: ${list.data.length}`);
  for (const p of list.data) {
    log(`  PR #${p.number} head=${JSON.stringify(p.head?.ref)} base=${JSON.stringify(p.base?.ref)} — ${String(p.title || "").slice(0, 60)}`);
  }

  const targets = selectDeliverablePRs(list.data, { headPrefix: HEAD_PREFIX, base: BASE });
  if (targets.length === 0) {
    log(`no open PRs matching head prefix "${HEAD_PREFIX}" and base "${BASE}" — done`);
    writeReport({ ok: true, delivered: 0, failed: [], openPrs: list.data.length });
    console.log(JSON.stringify({ ok: true, delivered: 0, failed: [] }, null, 2));
    return;
  }
  log(`found ${targets.length} open developer PR(s) to deliver`);

  const delivered = [];
  const failed = [];

  for (const pr of targets) {
    const head = normRef(pr.head.ref);
    const label = `CNB PR #${pr.number} (${head})`;
    // 评审加固：关闭 CNB PR 的前提 = GitHub PR 存在 + head SHA 一致 + 追溯评论已留。
    // 任一前提不成立 → CNB PR 保持 open，下次投递幂等重试（评审意见 P1/P5）。
    let ghUrl = null;
    let headSha = null;
    let closeReady = false;
    try {
      // 2) fetch head branch from CNB（记录被投递的确切 SHA）
      const fr = spawnSync("git", ["fetch", "--force", "origin", head], { encoding: "utf8" });
      if (fr.status !== 0) throw new Error(`git fetch failed: ${redact(fr.stderr)}`);
      headSha = spawnSync("git", ["rev-parse", "FETCH_HEAD"], { encoding: "utf8" }).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error(`cannot resolve head SHA for ${head}`);

      // 3) push to GitHub (same branch name; fast-forward only, no force)
      const pr1 = spawnSync(
        "git",
        [
          "-c", `credential.helper=!f(){ printf "username=x-access-token\\n"; printf "password=%s\\n" "${GH_TOKEN}"; }; f`,
          "-c", `lfs.https://github.com/${GH_REPO}.git/info/lfs.locksverify=false`,
          "push", `https://github.com/${GH_REPO}.git`, `${head}:${head}`,
        ],
        // helper 由 git 经 sh 执行，GH_TOKEN 必须进入子进程环境（凭据经管道传递，不落日志）
        { encoding: "utf8", env: { ...process.env, GH_TOKEN } },
      );
      if (pr1.status !== 0) {
        const err = redact(pr1.stderr || "");
        // rc-9：分叉拒绝必须给出可执行的恢复动作，而不是让 Owner 猜
        if (/non-fast-forward|fetch first|rejected/i.test(err)) {
          throw new Error(
            `GitHub 分支 ${head} 已存在且与 CNB 分叉（仅允许快进）。` +
            `恢复动作：确认以 CNB 内容为准后，删除 GitHub 分支（git push origin --delete ${head}）再重试投递；` +
            `或手工对齐两条分支。本次已安全跳过，未改动 GitHub。原始错误：${err.slice(0, 200)}`,
          );
        }
        throw new Error(`git push failed: ${err}`);
      }
      log(`pushed ${head} @ ${headSha.slice(0, 12)} to GitHub`);

      // 4) GitHub PR create-or-skip
      const search = await api("https://api.github.com", GH_TOKEN, "GET",
        `/repos/${GH_REPO}/pulls?head=csuzngjh:${encodeURIComponent(head)}&state=open`);
      const existing = Array.isArray(search.data) ? search.data : [];
      let ghPrNumber = null;
      if (existing.length > 0) {
        ghPrNumber = existing[0].number;
        ghUrl = existing[0].html_url;
        log(`GitHub PR already open: ${ghUrl} (branch updated)`);
      } else {
        const create = await api("https://api.github.com", GH_TOKEN, "POST", `/repos/${GH_REPO}/pulls`, {
          title: pr.title,
          head,
          base: BASE,
          body: [
            `Delivered by CNB bridge from CNB PR #${pr.number} (${CNB_WEB}/${CNB_REPO}/-/pulls/${pr.number}).`,
            "Generated by CNB auto-deliver (pull_request.target).",
            "",
            "Owner 在 GitHub 评审合并（canonical，合并一次）。",
          ].join("\n"),
        });
        if (!create.ok) {
          const detail = redact(JSON.stringify(create.data)).slice(0, 300);
          throw new Error(`GitHub PR create failed: HTTP ${create.status} ${detail}`);
        }
        ghPrNumber = create.data.number;
        ghUrl = create.data.html_url;
        log(`GitHub PR created: ${ghUrl}`);
      }

      // 评审加固（P1）：关闭 CNB PR 前验证 GitHub PR 存在且 head SHA 与推送一致
      const verify = await api("https://api.github.com", GH_TOKEN, "GET", `/repos/${GH_REPO}/pulls/${ghPrNumber}`);
      const ghHeadSha = verify.ok && verify.data && verify.data.head && verify.data.head.sha;
      if (!ghUrl || !ghHeadSha) throw new Error(`GitHub PR #${ghPrNumber} 状态异常（无法读取 head SHA）`);
      if (ghHeadSha !== headSha) {
        throw new Error(`GitHub PR #${ghPrNumber} head SHA（${ghHeadSha.slice(0, 12)}）与推送的 ${headSha.slice(0, 12)} 不一致——延迟关闭 CNB PR`);
      }

      // 5) 可追溯性（评审意见 5）：关闭前在 CNB PR 留下交付记录评论
      const traceBody = `Delivered to GitHub: ${ghUrl}\nhead SHA: \`${headSha}\`\n（由 cnb-github-auto-deliver 自动投递；Owner 请在 GitHub 评审合并）`;
      const commented = await api(CNB_API, CNB_TOKEN, "POST", `/${CNB_REPO}/-/pulls/${pr.number}/comments`, { body: traceBody });
      if (!commented.ok) {
        log(`WARN: 追溯评论发送失败（HTTP ${commented.status}）——CNB PR 保持 open，下次投递重试补评论后关闭`);
        throw new Error("traceability comment failed; CNB PR close deferred");
      }
      closeReady = true;

      // 6) 关闭 CNB PR（前提全部满足；失败仅告警，下次投递幂等重试）
      const close = await api(CNB_API, CNB_TOKEN, "PATCH", `/${CNB_REPO}/-/pulls/${pr.number}`, { state: "closed" });
      log(close.ok
        ? `CNB PR #${pr.number} closed（已留交付评论）`
        : `WARN: could not close CNB PR #${pr.number} (HTTP ${close.status}) — non-fatal, close it manually`);

      delivered.push({ cnbPr: pr.number, head, headSha, ghUrl });
    } catch (e) {
      log(`FAILED ${label}: ${redact(String(e.message || e))}`);
      log(closeReady ? `注意：${head} 已验证交付（${ghUrl}），仅关闭/评论未完成。` : `CNB PR #${pr.number} 保持 open，交付未完成。`);
      failed.push({ cnbPr: pr.number, head, error: redact(String(e.message || e)), ghUrl });
    }
  }

  const summary = { ok: failed.length === 0, delivered, failed };
  writeReport(summary);
  console.log(JSON.stringify(summary, null, 2));
  if (failed.length > 0) process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
