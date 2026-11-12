/**
 * Codex conversation-ingestion consent disclosure — G2A frozen text (Slice D),
 * amended by the Owner decision recorded as "Amendment 2 — disclosure v2"
 * (2026-11-12) in:
 *   docs/superpowers/specs/2026-08-28-codex-governance-closure-g0-g2a-decision.md
 *   § "Frozen consent disclosure text (setup will show this verbatim)"
 *
 * That document is the language SSoT. The frozen text "must not be weakened
 * during implementation without a new Owner decision" — the guard test
 * (codex-disclosure-g2a-guard.test.ts) re-extracts the frozen section from
 * the document and asserts byte equality with this constant, so any drift
 * here fails CI.
 *
 * v2 (g2b) corrects the "what PD reads" paragraph: the model's own plaintext
 * thinking summary IS stored (it is visible in the Codex UI); the encrypted
 * reasoning body is neither read nor saved. The version advanced so that a
 * consent granted against the old disclosure falls back to the bounded tier
 * instead of silently widening what is stored.
 *
 * The English rendering states the same facts; per the G2A binding note it is
 * produced at setup implementation time from the frozen Chinese text. Setup
 * surfaces always present the Chinese SSoT first.
 */

export const CODEX_INGESTION_DISCLOSURE_VERSION = 'g2b-2026-11-12';

export type CodexIngestionDisclosureLanguage = 'zh' | 'en';

export const CODEX_INGESTION_DISCLOSURE_ZH = `### Principles Disciple — 对话观察与治理闭环（Codex）

**开启后 PD 会读取什么？**
读取本工作区内 Codex 明确提供给 PD 的会话记录（transcript）。进入治理观察的只有可见内容：你发出的消息、助手的可见回复、工具调用的名称/输入/结果（用于识别反复出现的问题），以及模型自己写出的思考摘要（一段简短文字，Codex 界面上也会显示给你）。Codex 另外以加密形式保存的完整思考正文，PD 既不读取也不保存。记录中同时存在的系统/开发者提示词、宿主注入的环境上下文，会在解析时被识别并丢弃——不会被保存、不会进入日志、不会发送给诊断模型。

**为什么读取？**
为了让 PD 在 Codex 上完成它承诺的闭环：把你反复纠正的地方变成一条可审查的原则候选——你需要先看到证据，再决定是否采纳。不解析对话，PD 就只能管工具，学不到纠正。

**保存多少、多久？**
每个会话只保留最近 32 条可见消息、最多 7 天（先到期先删除）。当某个问题被正式立为 pain 时，才会把它的前 12 条消息 + 触发点 + 助手的下一条完整回复升级为长期治理证据，按现有治理数据的生命周期管理。保存的工具证据在落盘前会经过既有的敏感字段与常见密钥格式脱敏；但请注意：如果一段密钥看起来就像普通文字，任何过滤器都无法识别它——请不要让 PD 观察包含此类内容的会话。

**数据会离开本机吗？**
观察数据本身只存在本机工作区。被升级为治理证据的对话片段，会像现有诊断流程一样发送给你配置的 LLM API 做诊断——这是唯一的外发路径，与 OpenClaw 上的现有行为一致。产品遥测不包含任何消息内容或会话标识。

**如何关闭？随时。**
关闭后 PD 立即停止读取 transcript（不是"读了再丢弃"，而是根本不打开）。已有的原则注入、工具拦截、既有工具证据完全不受影响。已保存的内容按上述期限自然过期；升级过的证据只能由你通过既有治理清理命令显式删除。卸载不会静默删除任何证据。

**默认状态？**
默认关闭。只有你在看到本说明后明确选择开启才会生效；升级 PD 永远不会替你开启。`;

export const CODEX_INGESTION_DISCLOSURE_EN = `### Principles Disciple — Conversation Observation & Governance Closure (Codex)

**What does PD read once enabled?**
PD reads the Codex session transcripts that Codex explicitly provides to PD inside this workspace. Only visible content enters governance observation: the messages you send, the assistant's visible replies, the names/inputs/results of tool calls (used to recognize recurring problems), and the short thinking summaries the model writes (the same text Codex shows you in its UI). The full reasoning body that Codex keeps in encrypted form is neither read nor saved by PD. System/developer prompts and host-injected environment context present in the same records are recognized and discarded during parsing — never saved, never written to logs, never sent to the diagnosis model.

**Why read at all?**
So that PD can deliver on its promised closed loop on Codex: turning the places you repeatedly correct into a reviewable principle candidate — you see the evidence first, then decide whether to adopt it. Without parsing conversations, PD can only govern tools and cannot learn your corrections.

**How much is kept, and for how long?**
Per session, only the most recent 32 visible messages are kept, for at most 7 days (expired first, deleted first). Only when a problem is formally established as a pain are its preceding 12 messages + the trigger point + the assistant's next complete reply promoted into long-term governance evidence, managed under the existing governance data lifecycle. Saved tool evidence passes through the existing sensitive-field and common-secret-format redaction before being written; but note: if a secret looks like ordinary text, no filter can recognize it — please do not let PD observe sessions containing such content.

**Does data leave this machine?**
Observation data itself lives only in the local workspace. Conversation fragments promoted into governance evidence are sent to your configured LLM API for diagnosis, exactly like the existing diagnosis flow — this is the only egress path, consistent with current behavior on OpenClaw. Product telemetry contains no message content and no session identifiers.

**How do I turn it off? Anytime.**
Once off, PD immediately stops reading transcripts (not "read then discard" — the transcript is never opened at all). Existing principle injection, tool interception, and existing tool evidence are completely unaffected. Saved content expires naturally per the limits above; promoted evidence can only be deleted explicitly by you through the existing governance cleanup commands. Uninstall never silently deletes any evidence.

**Default state?**
Off by default. It takes effect only after you explicitly choose to enable it after seeing this disclosure; upgrading PD never enables it for you.`;

export function getCodexIngestionDisclosureText(language: CodexIngestionDisclosureLanguage): string {
  return language === 'en' ? CODEX_INGESTION_DISCLOSURE_EN : CODEX_INGESTION_DISCLOSURE_ZH;
}
