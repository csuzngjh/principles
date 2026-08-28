# Codex Governance Closure — G0 + G2A Owner Decision Package

- **Status:** PROPOSED — awaiting explicit Owner approval. Nothing in this
  document is an approved decision yet.
- **Date prepared:** 2026-08-28
- **SPEC revision this decision identifies:** `docs/superpowers/specs/2026-08-28-codex-governance-closure-spec.md` rev 2 (merged as PR #1437, merge commit `00eabfc7`)
- **Evidence:** G1 probe report `docs/architecture/CODEX_G1_CONTRACT_PROBE_REPORT.md` (G1 = GO);
  fixtures `packages/codex-adapter/tests/fixtures/g1-contract/`

This package compresses the two remaining Slice 0 gates into one Owner
reading. The Owner makes exactly two decisions:

- **Decision 1 (G0):** approve the bounded MVP exception for Codex
  conversation ingestion, the Companion-owned Workspace worker, and the ADR /
  roadmap amendments below.
- **Decision 2 (G2A):** approve the data policy and consent disclosure text
  in the second half of this document.

---

# Decision 1 — G0: Owner MVP exception

## What the Owner is approving

Allowing PD, for the Codex host only, to close the governance loop it already
advertises (correction → pain → diagnosis → candidate → Owner decision →
later behavior) by adding four narrowly bounded capabilities:

1. **Codex conversation ingestion (bounded)** — reading the Codex transcript
   that the authenticated hook itself points to, keeping at most the latest
   32 visible turns per rollout for at most 7 days, promoting at most
   12 preceding turns + trigger + next completed assistant turn into the
   existing governance evidence lifecycle when a pain is admitted. Codex
   remains the conversation authority; PD never builds a session replay,
   search, export, or general memory product.
2. **One Companion-owned Workspace diagnosis worker** — a single
   Workspace-scoped background worker in the existing PD Companion app that
   catches up transcript lag and leases pending Diagnostician tasks, so
   diagnosis no longer depends on the OpenClaw plugin lifecycle. It runs no
   LLM inside hooks and cannot approve anything.
3. **Codex durable STRONG-correction rate limit** — persisting the
   correction detector's STRONG per-session rate-limit bucket in
   `trajectory.db` for Codex admission only, because every Codex hook is a
   fresh subprocess where in-memory buckets are dead on arrival.
4. **One quiet, default-off feature flag** — `codex_conversation_ingestion`
   in the existing feature-flag registry, so ingestion is explicit opt-in and
   independently reversible.

## What stays forbidden (no approval requested)

- general memory, session replay/search/export, bulk transcript mirroring;
- reading transcripts of sessions the enabled Workspace hook did not observe
  (no home-directory scanning, no "latest session" guessing);
- hidden reasoning, chain-of-thought, system/developer prompts, or secrets in
  any store, log, stdout, or telemetry;
- a second canonical pain identity (the existing
  `production-pain-evidence.ts` derivation stays the only authority);
- automatic Owner approval of any Principle;
- changes to OpenClaw's existing in-memory cooldown behavior.

## Proposed ADR-0020 amendment (applied only after approval)

Add a dated amendment section to `docs/adr/0020-codex-cli-host-adapter.md`
with the following content:

1. **§10.3 exception record.** The 2026-08-28 Owner MVP exception (this
   decision, recorded against SPEC rev 2) narrows two deferrals for the Codex
   host: (a) cross-session continuation is satisfied by one
   Companion-owned, Workspace-scoped diagnosis worker whose only background
   responsibilities are transcript catch-up, reconciliation, and Diagnostician
   leasing; (b) this worker is not a general daemon platform and adds no
   second long-running service. All other §10.3 deferrals stand.
2. **Codex conversation ingestion authorization.** Bounded ingestion per SPEC
   §11 under the `codex_conversation_ingestion` quiet flag (default off),
   gated additionally by G2A consent. Codex remains host-conversation
   authority; the G1 probe (Stop event, flushed transcript, path containment)
   is the contract baseline: minimum supported Codex 0.148.0, verified
   on-device at 0.150.1.
3. **Rate-limit compatibility decision (records deliberate drift from the
   2026-08-14 clarification).** The 2026-08-14 cooldown clarification rejected
   SQLite persistence for the **tool-pain cooldown**, and that rejection
   stands unchanged — OpenClaw's and Codex's tool-pain cooldown behavior is
   not modified by this SPEC. The STRONG **correction-detector** rate-limit
   bucket is a different mechanism (`signal-collector-host.ts`), and for
   Codex admission only it moves to a transactional `trajectory.db` bucket
   keyed by Workspace, root session, rule version, and time window, because
   fresh-subprocess hooks make process-local state dead state. Recording this
   distinction prevents the two mechanisms from being silently conflated.
4. **Canonical pain identity.** The single canonical pain authority is the
   existing content-derived `production-pain-evidence.ts` derivation with the
   unique `pain_events.canonical_pain_id` index. The correction path's
   current `correction_<traceId>` random ids
   (`signal-collector-host.ts` `routeStrong`) are declared legacy behavior to
   be converged in Slice B; a trace id may remain a correlation field but is
   never dedup identity.
5. **Stale wording fix.** §10.5.1 item 1 says the code "queries
   `pain_signals`"; production code queries **`pain_events`** (verified
   against `production-pain-evidence.ts` at merge `00eabfc7`). The amendment
   corrects the table name without changing the described idempotency
   behavior, which remains accurate.

## Proposed roadmap change (applied only after approval)

In `docs/plans/post-mvp-conditional-roadmap.md`, record the Owner
`mvp-exception` against SPEC rev 2 per the file's §0 rule 1: the
Codex-closure work (Slices A–D + R1) enters In Progress with this decision as
trigger evidence, scoped to the exception above. The related Hold items
(§18.2 Codex memory pipeline and its long-running-service dependency)
remain Hold outside the narrow worker defined here.

## G0 completion checklist (post-approval)

- [ ] Owner approval recorded (Linear PRI-617 comment or GitHub, identifying
      SPEC rev 2 and this document);
- [ ] ADR-0020 amendment applied as proposed above;
- [ ] roadmap entry recorded as Active per §0 rule 1;
- [ ] traceability: SPEC rev 2 ↔ this document ↔ approval record linked.

**Until that approval exists: G0 = AWAITING OWNER APPROVAL. No production
implementation work is authorized.**

---

# Decision 2 — G2A: Data policy + consent disclosure

## Data policy (normative, mirrors SPEC §11/§16/§17)

**PD reads** (only after explicit opt-in, and only the transcript the
authenticated Codex hook itself provides):

- visible user messages (genuine `user.text` records, not host-injected
  context);
- visible assistant messages (commentary + final);
- tool-call facts needed for governance (tool name, inputs, result/error/
  exit code) — the same facts the existing tool-evidence path already
  captures.

**PD never reads or stores:** hidden reasoning or chain-of-thought (Codex
stores reasoning encrypted; PD skips those records entirely), system or
developer prompts, host-injected environment/skills/plugin context, secrets,
approval tokens, environment snapshots.

**Retention bounds:**

- operational buffer: latest ≤ 32 visible turns per rollout, ≤ 7 days
  (whichever removes content sooner);
- on admitted pain, promotion of ≤ 12 preceding visible turns + the
  triggering observation + the next completed assistant turn into the
  existing pain-evidence lifecycle (retained governance evidence);
- after unpromoted content expires, only identity/checkpoint/count/
  degradation/tombstone facts may remain — never message text;
- no UI or CLI offers session replay, full-text search, or bulk export.

**Where data lives and goes:** all observation storage is local
(`{workspace}/.state/trajectory.db`). Product telemetry stays coarse and
carries no message text or session identifiers. **One real remote path
exists and is disclosed honestly:** promoted evidence windows are the input
to PD's Diagnostician, which calls the configured LLM API — the same
destination as every existing diagnosis on the OpenClaw host. Nothing is
uploaded anywhere else. The disclosure below states this plainly.

**Controls:** `codex_conversation_ingestion = false` (or declining consent)
means PD does not open or read the transcript at all — prompt injection,
RuleHost, and existing tool governance continue unchanged. Disabling stops
future reads immediately; existing operational content ages out; promoted
evidence is removed only through the existing, backup-first governance
cleanup commands. Uninstall never deletes evidence silently.

## Frozen consent disclosure text (setup will show this verbatim)

> ### Principles Disciple — 对话观察与治理闭环（Codex）
>
> **开启后 PD 会读取什么？**
> 只读取本工作区内 Codex 明确提供给 PD 的会话记录（transcript）中的可见内容：你发出的消息、助手的可见回复、以及工具调用的名称/输入/结果（用于识别反复出现的问题）。不会读取助手的隐藏思考过程（Codex 以加密形式保存，PD 直接跳过）、系统提示词、环境上下文或任何密钥。
>
> **为什么读取？**
> 为了让 PD 在 Codex 上完成它承诺的闭环：把你反复纠正的地方变成一条可审查的原则候选——你需要先看到证据，再决定是否采纳。不读取对话，PD 就只能管工具，学不到纠正。
>
> **保存多少、多久？**
> 每个会话只保留最近 32 条可见消息、最多 7 天（先到期先删除）。当某个问题被正式立为 pain 时，才会把它的前 12 条消息 + 触发点 + 助手的下一条完整回复升级为长期治理证据，按现有治理数据的生命周期管理。
>
> **数据会离开本机吗？**
> 观察数据本身只存在本机工作区。被升级为治理证据的对话片段，会像现有诊断流程一样发送给你配置的 LLM API 做诊断——这是唯一的外发路径，与 OpenClaw 上的现有行为一致。产品遥测不包含任何消息内容或会话标识。
>
> **如何关闭？随时。**
> 关闭后 PD 立即停止读取 transcript（不是"读了再丢弃"，而是根本不打开）。已有的原则注入、工具拦截、既有工具证据完全不受影响。已保存的内容按上述期限自然过期；升级过的证据只能由你通过既有治理清理命令显式删除。卸载不会静默删除任何证据。
>
> **默认状态？**
> 默认关闭。只有你在看到本说明后明确选择开启才会生效；升级 PD 永远不会替你开启。

*(English rendering of the same text is produced at setup implementation
time from this frozen Chinese text; both must state the facts above. The
language SSoT is this document.)*

## G2A completion checklist (post-approval)

- [ ] Owner approves the data policy and the disclosure text above, recorded
      against SPEC rev 2 (Linear PRI-619 or GitHub);
- [ ] this document's status changes from PROPOSED to APPROVED with the
      approval reference;
- [ ] Slice D implements setup consent using this frozen text; R1 verifies it
      on the installed path.

**Until that approval exists: G2A = AWAITING OWNER APPROVAL. The disclosure
text above is frozen for review and must not be weakened during
implementation without a new Owner decision.**

---

## Approval record (to be filled by the Owner or on the Owner's recorded instruction)

```text
G0 decision: APPROVED / REJECTED   — date, channel, exact wording:
G2A decision: APPROVED / REJECTED  — date, channel, exact wording:
SPEC revision identified: rev 2 (PR #1437, merge 00eabfc7)
```
