# Install Integrity Verification SPEC

> Status: **Proposed** | Date: 2026-09-04 | Author: WorkBuddy (agent draft — per ADR governance, `Accepted` requires Owner decision evidence)
>
> Audience: PD maintainers, installer authors (`create-principles-disciple`), Companion authors.
> Related: `AGENTS.md` §1.1 (Installed Runtime Boundary), `packages/create-principles-disciple`, `packages/pd-companion`, `packages/pd-cli` (`console open`), `packages/install-layout`.

---

## 0. TL;DR

The installed runtime (`~/.pd/runtime` + the OpenClaw plugin shell) is a plain writable directory. Nothing detects when its files are modified outside an install run; corruption surfaces only as a cryptic downstream launch failure. This SPEC adds:

1. an **install manifest** (`MANIFEST.sha256`) written by the installer;
2. a **verify step** in `pd console open` and in PD Companion launch that compares the on-disk tree against the manifest and fails *loud and structured* with a repair action;
3. a **repair path** that re-extracts mismatched files from the install payload (or instructs re-running the installer when the payload is unavailable);
4. a small diagnostic fix: `pd console open --json` must include the console server's stderr tail in the failure result instead of swallowing it.

Non-goal: this is **not** a security boundary against a malicious local administrator. It is a tripwire that converts silent accidental corruption into an immediate, actionable diagnostic.

---

## 1. Problem

### 1.1 Incident (2026-09-03)

- 14:33–14:37 — installer ran; `~/.pd/runtime` healthy.
- 15:06 — `~/.pd/runtime/console/dist/server.js` overwritten with the 16-byte natural-language text `new console code`, outside any install run. Writer not attributable from available logs (excluded: WorkBuddy / opencode / Claude / Codex / OpenClaw agent sessions, shell histories, editor local histories).
- From then on, every PD Companion launch failed with `console_exited_with_code_1`; Companion autostarts at login, so the failure repeated every sign-in.
- The reported `nextAction` ("Check console logs above") was empty guidance: in `--json` mode the CLI spawns the server with piped stdio and discards its stderr.

Total time-to-diagnosis: ~16 hours of wall time and a manual run of the server entry to surface the real `SyntaxError`.

### 1.2 Structural causes

1. **Identical-path confusion.** On a combined dev+prod machine, four PD-looking trees coexist (repo, installed runtime, plugin shell, runtime workspace) with identical relative paths. Writing to the wrong one costs nothing and is noticed by nobody.
2. **No integrity tripwire.** The install directory is unprotected: no write guard, no checksum, no startup self-check.
3. **Opaque failure surface.** The failure reason does not carry the server's actual error, so even attentive operators are sent in the wrong direction.
4. **Multiple concurrent writers.** Several agent hosts and a human operate on the same machine; no one owns the installed tree's consistency.

### 1.3 Prior art already in repo

- `@principles/install-layout` already centralizes *where* things are installed (`resolveInstallLayout`, canonical vs legacy). Integrity is the missing *what state they are in*.

---

## 2. Design

### 2.1 Install manifest

The installer already materializes every file it writes. At the end of an install/update run it additionally writes:

```
~/.pd/runtime/MANIFEST.sha256
~/.openclaw/extensions/principles-disciple/MANIFEST.sha256
```

Format (JSON, one object — grep-able, diff-able, trivially verifiable without new dependencies):

```json
{
  "version": 1,
  "generatedAt": "2026-09-04T00:00:00.000Z",
  "generatedBy": "create-principles-disciple@<version>",
  "files": {
    "console/dist/server.js": "sha256:<hex>",
    "pd-cli/dist/index.js": "sha256:<hex>"
  }
}
```

Rules:

- Paths are relative, POSIX-style, one entry per installed file (including `MANIFEST.sha256`'s own siblings; the manifest never lists itself).
- Symlinks/junctions are recorded as `"link:<target>"` instead of a hash (e.g. the legacy extension's `core` entry).
- `node_modules/` **is included** — it is installed payload and was a real failure site (missing `@principles/host-runtime` in the legacy layout, 2026-09-01/02). If hashing cost becomes a problem on slow machines, cap with a size budget and record oversized files as `"size:<bytes>"` instead of hashing; v1 measures first, optimizes only with evidence.
- The manifest is the *only* file in the install tree that the installer may rewrite outside a version change: it is rewritten on every successful install/update.

### 2.2 Verify

New shared module in `@principles/install-layout` (the existing owner of install-tree knowledge):

```
verifyInstallIntegrity(paths) →
  | { status: 'ok', checked: number }
  | { status: 'no_manifest' }
  | { status: 'mismatch', missing: string[], modified: string[], extra_ignored_note?: string }
```

- `missing`: listed in manifest, absent on disk.
- `modified`: listed, present, hash differs.
- Files on disk but not in the manifest are **not** an error (runtime may legitimately drop caches); reported as a count for observability only.

Consumers:

1. **`pd console open`** — verifies before spawning the server.
   - `mismatch` → do not spawn; emit structured failure:
     `reason: 'install_integrity_mismatch: modified console/dist/server.js (+2 more)'`,
     `nextAction: 'Run: npx create-principles-disciple --repair (or re-run the installer)'`.
   - `no_manifest` → proceed with a logged warning (older installs predate the manifest; the *next* install writes one). Fail-open here is deliberate: absence of the tripwire must not brick existing installs.
2. **PD Companion** — same check before `spawning_cli`; `mismatch` maps to a new degraded reason `install_tampered` with title「安装文件已被修改」and the repair next action. This replaces the misleading `console_exited_with_code_1` class for the corruption scenario.
3. **`pd doctor`** (new subcommand, thin wrapper over `verifyInstallIntegrity` for both roots) so users/automation can check on demand. Machine-readable with `--json`.

### 2.3 Repair

- `create-principles-disciple --repair`: re-runs the normal install flow (which already overwrites the tree) and rewrites the manifest. No new machinery — repair IS install; the flag exists to be a memorable, documentable verb in `nextAction` strings.
- v1 does **not** implement surgical per-file re-extraction; a full reinstall is the repair. (Per `P3`/`P7`: build the smallest thing that converts silent corruption into a one-command fix. Surgical repair becomes a follow-up candidate if reinstall proves too slow in practice.)

### 2.4 Stderr passthrough fix (same failure surface)

`pd console open --json` currently spawns the server with piped stdio and discards stderr (`packages/pd-cli/dist/commands/console.js`). Change: capture the last ~2 KB of server stderr; on `console_exited_with_code_N` include a bounded tail in the JSON result:

```json
{
  "status": "failed",
  "reason": "console_exited_with_code_1",
  "stderrTail": "…SyntaxError: Unexpected identifier 'code'…",
  "nextAction": "…"
}
```

Companion renders `stderrTail` (sanitized, length-capped — it already treats CLI stdout as untrusted input per rc-1/rc-2) under the degraded page's「原因」.

### 2.5 Optional hard guard (deferred by default)

An OS-level read-only lock of the install tree (file ReadOnly attribute or NTFS deny-ACL) with installer-managed unlock/re-lock. **Not in v1 scope**: it changes installer behavior on every update path and risks breaking legitimate runtime writes we have not yet enumerated. The maintainer-side prototype exists (`pd-runtime-lock.ps1`/`pd-runtime-lock.mjs`, 2026-09-04) and informs a later decision; the manifest+verify tripwire in v1 already closes the *silent* part of the failure.

---

## 3. MVP triage (stable contract IDs)

- **`mvp-q-1-what-if-skip`**: Skipping means the next accidental overwrite of an installed file again surfaces hours later as a misleading launch error on a user-facing surface (Companion), with no path to self-diagnosis. The 2026-09-03 incident is concrete evidence of the cost.
- **`mvp-q-2-how-observed`**: (a) `pd doctor --json` reports `status: ok` with a checked-file count on healthy installs; (b) deliberately modifying one installed file makes `pd console open --json` refuse with `install_integrity_mismatch` naming that file; (c) Companion shows the「安装文件已被修改」degraded page instead of `console_exited_with_code_1`; (d) a killed server process surfaces its real error via `stderrTail`.
- **`mvp-q-3-how-disabled`**: No new feature flag. Verify failure is a *diagnostic*, not a gate that can be toggled off; `no_manifest` is fail-open for legacy installs; repair is a full reinstall, always available.
- **`mvp-q-4-emotional-value`**: Directly targets Owner-visible trust: the difference between "PD is broken again, no idea why" and "this file was modified outside the installer; run one command to repair".

## 4. Acceptance criteria

1. Fresh install writes both manifests; `pd doctor --json` returns `status: ok`.
2. Modify one byte in any installed file → `pd doctor` reports it as `modified`; `pd console open --json` refuses with `install_integrity_mismatch` naming the file; Companion maps it to the `install_tampered` degraded page.
3. Delete one installed file → reported as `missing` on the same surfaces.
4. Pre-manifest install (manifest deleted) → `no_manifest`: console open proceeds with a warning; next install restores the manifest.
5. Kill the server with a stderr-producing crash → failure JSON contains a bounded `stderrTail` with the actual error.
6. `create-principles-disciple --repair` restores modified/deleted files and the manifest; `pd doctor` is green afterwards.

## 5. Test strategy (per P5)

- Manifest writer: unit tests over a temp install tree (hash format, symlink entries, determinism).
- `verifyInstallIntegrity`: unit + property tests (ok / missing / modified / no-manifest).
- `pd console open`: integration test against a fixture install tree with a deliberately corrupted file — assert refusal reason + no spawn.
- Companion: supervisor-level test mapping `install_tampered` (mirrors existing `mapLaunchFailureReason` tests).
- Stderr passthrough: integration test asserting bounded `stderrTail` content and length cap.

## 6. Out of scope / follow-up candidates

- OS-level write lock of the install tree (§2.5) — decide after v1 lands.
- Surgical per-file repair without full reinstall.
- Signature (not just hash) verification of install payloads — only if a real supply-chain requirement emerges; hashes target *accidental* corruption.
- Telemetry/console self-integrity events into product signals (needs Owner decision on signal semantics).

---

*Drafted from the 2026-09-03 incident investigation. Remains `Proposed` until Owner review; acceptance must be recorded with decision evidence per the ADR governance rule.*
