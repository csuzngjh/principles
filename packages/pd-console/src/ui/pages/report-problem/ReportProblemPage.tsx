import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog.js";
import {
  createFeedbackReport,
  listFeedbackReports,
  getFeedbackReport,
  deleteFeedbackReport,
  fetchConfigSummary,
  fetchFeedbackChannels,
  submitFeedbackReport,
  markFeedbackReportSent,
  request,
} from "../../api.js";
import { enumLabel } from "../../utils/enum-labels.js";
import type { FeedbackChannelStatusData } from "../../utils/validators.js";
import {
  parseDraftRecord,
  parseDraftSummary,
  parseEnvelopeReport,
  getErrorMessage,
  buildFeedbackContextFromSearchParams,
  buildFeedbackDiagnostics,
  deriveFeedbackArea,
} from "../ReportProblemValidators.js";
import type {
  FeedbackDraftSummary,
  DraftRecord,
  FeedbackType,
  FeedbackFrequency,
  FeedbackBlockingLevel,
} from "../ReportProblemValidators.js";

// ── Form state ────────────────────────────────────────────────────────────────

interface FormState {
  type: FeedbackType;
  title: string;
  description: string;
  // bug 模板
  stepsToReproduce: string;
  expectedBehavior: string;
  actualBehavior: string;
  // 类型化新增(Slice 3, spec §6):全部可选,按 type 条件渲染
  frequency: FeedbackFrequency | undefined;
  blockingLevel: FeedbackBlockingLevel | undefined;
  goal: string;
  stuckAt: string;
  job: string;
  currentWorkaround: string;
  sawWhat: string;
  whereSeen: string;
  submitting: boolean;
}

const INITIAL_FORM: FormState = {
  type: "bug",
  title: "",
  description: "",
  stepsToReproduce: "",
  expectedBehavior: "",
  actualBehavior: "",
  frequency: undefined,
  blockingLevel: undefined,
  goal: "",
  stuckAt: "",
  job: "",
  currentWorkaround: "",
  sawWhat: "",
  whereSeen: "",
  submitting: false,
};

const FEEDBACK_TYPES: FeedbackType[] = ["bug", "confusing", "privacy_concern", "feature_request", "other"];
const VALID_FEEDBACK_TYPES = new Set<string>(FEEDBACK_TYPES);
const FREQUENCY_OPTIONS: readonly FeedbackFrequency[] = ["always", "often", "sometimes", "once"];
const BLOCKING_OPTIONS: readonly FeedbackBlockingLevel[] = ["blocked", "workaround", "minor"];
const VALID_FREQUENCIES = new Set<string>(FREQUENCY_OPTIONS);
const VALID_BLOCKING = new Set<string>(BLOCKING_OPTIONS);

// 每类型对应的"补充细节"条件字段(spec §6)。标题与描述恒显;其余按 type 折叠。
const PER_TYPE_DETAIL_FIELDS: Record<FeedbackType, Array<keyof FormState>> = {
  bug: ["stepsToReproduce", "expectedBehavior", "actualBehavior", "frequency", "blockingLevel"],
  confusing: ["goal", "stuckAt", "blockingLevel"],
  feature_request: ["job", "currentWorkaround"],
  privacy_concern: ["sawWhat", "whereSeen"],
  other: [],
};

// 文本类字段的 i18n 标签键(select 类频率/阻塞度单独处理)。
const DETAIL_FIELD_LABEL: Record<string, string> = {
  stepsToReproduce: "pages.reportProblem.form.stepsLabel",
  expectedBehavior: "pages.reportProblem.form.expectedLabel",
  actualBehavior: "pages.reportProblem.form.actualLabel",
  goal: "pages.reportProblem.form.goalLabel",
  stuckAt: "pages.reportProblem.form.stuckAtLabel",
  job: "pages.reportProblem.form.jobLabel",
  currentWorkaround: "pages.reportProblem.form.currentWorkaroundLabel",
  sawWhat: "pages.reportProblem.form.sawWhatLabel",
  whereSeen: "pages.reportProblem.form.whereSeenLabel",
};

const CHANNEL_ORDER: Array<FeedbackChannelStatusData["id"]> = ["ingest", "github", "email", "file"];

// 类型默认值按来源推断(spec §6):failed-tasks / error 入口 → bug,通用入口 → other。
function defaultTypeFromParams(searchParams: URLSearchParams): FeedbackType {
  const context = buildFeedbackContextFromSearchParams(searchParams);
  const area = deriveFeedbackArea(context);
  if (area === "failed_tasks" || area === "error") return "bug";
  return "other";
}

// ── Runtime validator for drafts list envelope (H section / ERR-001/005/009) ─

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type DraftsListResult =
  | { ok: true; drafts: FeedbackDraftSummary[] }
  | { ok: false; reason: string };

function validateDraftsList(raw: unknown): DraftsListResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: "Drafts list response is not an object" };
  }
  if (!Object.hasOwn(raw, "drafts")) {
    return { ok: false, reason: "Drafts list response missing 'drafts' field" };
  }
  if (!Array.isArray(raw.drafts)) {
    return { ok: false, reason: "Drafts list 'drafts' field is not an array" };
  }
  const result: FeedbackDraftSummary[] = [];
  for (const item of raw.drafts) {
    const parsed = parseDraftSummary(item);
    if (parsed !== null) {
      result.push(parsed);
    }
  }
  return { ok: true, drafts: result };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function NoAutoUploadBanner() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 px-4 py-3 bg-gov/8 border border-gov/20 rounded-[6px] mb-6">
      <svg
        className="shrink-0 w-4 h-4 text-gov"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
      <span className="text-ink text-sm font-medium">{t("pages.reportProblem.noAutoUpload")}</span>
    </div>
  );
}

function PrivacySection({ draft }: { draft: DraftRecord | null }) {
  const { t } = useTranslation();

  if (draft === null) {
    return (
      <section className="mt-8" aria-labelledby="section-privacy">
        <SectionTitle id="section-privacy">{t("pages.reportProblem.privacy.title")}</SectionTitle>
        <p className="text-ink-3 text-[13px] leading-relaxed">
          {t("pages.reportProblem.privacy.submitFirst")}
        </p>
        <NoAutoUploadBanner />
      </section>
    );
  }

  return (
    <section className="mt-8" aria-labelledby="section-privacy">
      <SectionTitle id="section-privacy">{t("pages.reportProblem.privacy.title")}</SectionTitle>
      <p className="text-ink-3 text-[13px] leading-relaxed mb-4">
        {t("pages.reportProblem.privacy.description")}
      </p>

      <div className="bg-panel border border-line rounded-[6px] p-4 space-y-4">
        {/* Included */}
        <div>
          <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
            {t("pages.reportProblem.privacy.included")}
          </h3>
          {draft.privacy.includedSections.length > 0 ? (
            <ul className="space-y-1">
              {draft.privacy.includedSections.map((section, i) => (
                <li key={i} className="flex items-center gap-2 text-ink-2 text-[13px]">
                  <span className="text-green-600" aria-hidden="true">✓</span>
                  {section}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-4 text-[13px]">—</p>
          )}
        </div>

        {/* Excluded */}
        <div>
          <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
            {t("pages.reportProblem.privacy.excluded")}
          </h3>
          {draft.privacy.excludedByDefault.length > 0 ? (
            <ul className="space-y-1">
              {draft.privacy.excludedByDefault.map((section, i) => (
                <li key={i} className="flex items-center gap-2 text-ink-2 text-[13px]">
                  <span className="text-red-500" aria-hidden="true">✗</span>
                  {section}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-4 text-[13px]">—</p>
          )}
        </div>

        {/* Redaction notes */}
        {draft.privacy.redactionNotes.length > 0 && (
          <div>
            <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-2">
              {t("pages.reportProblem.privacy.notes")}
            </h3>
            <ul className="space-y-1">
              {draft.privacy.redactionNotes.map((note, i) => (
                <li key={i} className="text-ink-2 text-[13px]">• {note}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <NoAutoUploadBanner />
    </section>
  );
}

function StatusBadge({ draft }: { draft: DraftRecord }) {
  const { t } = useTranslation();
  const submitted = draft.status === "submitted";
  return (
    <span
      className={
        submitted
          ? "inline-flex items-center gap-1 px-2 py-[2px] rounded-[3px] text-[11px] font-medium border border-green-200 bg-green-50 text-green-700"
          : "inline-flex items-center gap-1 px-2 py-[2px] rounded-[3px] text-[11px] font-medium border border-line bg-surface text-ink-3"
      }
    >
      <span className={submitted ? "w-1.5 h-1.5 rounded-full bg-green-500" : "w-1.5 h-1.5 rounded-full bg-ink-3"} aria-hidden="true" />
      {submitted ? t("pages.reportProblem.draft.sentBadge") : t("pages.reportProblem.draft.draftBadge")}
    </span>
  );
}

function DraftCard({ draft, onCopyMarkdown, onCopyEmail, onOpenGithub, onOpenEmail, onDelete }: {
  draft: DraftRecord;
  onCopyMarkdown: () => void;
  onCopyEmail: () => void;
  onOpenGithub: () => void;
  onOpenEmail: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <article className="bg-panel border border-line rounded-[6px] p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="font-mono text-[11px] text-ink-3">
          {t("pages.reportProblem.draft.savedAt", { id: draft.id, at: draft.createdAt })}
        </div>
        <StatusBadge draft={draft} />
      </div>
      <div className="font-semibold text-ink mb-1">{draft.title}</div>

      {/* 回执 / 提交元数据(Slice 3, spec §11.3) */}
      {(draft.status === "submitted" || draft.trackingId || draft.submittedVia) && (
        <div className="text-ink-3 text-[12px] mb-2 space-y-0.5">
          {draft.submittedVia && (
            <div>via {draft.submittedVia}{draft.submittedAt ? ` · ${draft.submittedAt}` : ""}</div>
          )}
          {draft.trackingId && (
            <div className="font-mono">{t("pages.reportProblem.channel.receiptTrackingId")}: {draft.trackingId}</div>
          )}
          {draft.externalUrl && (
            <div>
              <a href={draft.externalUrl} target="_blank" rel="noreferrer noopener" className="text-gov underline hover:text-gov-2">
                {t("pages.reportProblem.channel.openIssue")}
              </a>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCopyMarkdown}
          className="border border-line bg-surface text-ink rounded-[3px] px-[12px] py-[5px] text-[12px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          {t("pages.reportProblem.draft.copyMarkdown")}
        </button>
        <button
          type="button"
          onClick={onCopyEmail}
          className="border border-line bg-surface text-ink rounded-[3px] px-[12px] py-[5px] text-[12px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
        >
          {t("pages.reportProblem.draft.copyEmail")}
        </button>
        {draft.outputs.githubIssueUrl && (
          <button
            type="button"
            onClick={onOpenGithub}
            className="border border-line bg-surface text-ink rounded-[3px] px-[12px] py-[5px] text-[12px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("pages.reportProblem.draft.openGithub")}
          </button>
        )}
        {draft.outputs.mailtoUrl && (
          <button
            type="button"
            onClick={onOpenEmail}
            className="border border-line bg-surface text-ink rounded-[3px] px-[12px] py-[5px] text-[12px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("pages.reportProblem.draft.openEmail")}
          </button>
        )}
        {!confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="border border-red-200 text-red-600 rounded-[3px] px-[12px] py-[5px] text-[12px] hover:bg-red-50 transition-colors focus-visible:outline-2 focus-visible:outline-red-400 focus-visible:outline-offset-2"
          >
            {t("pages.reportProblem.draft.delete")}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onDelete}
              className="border border-red-400 bg-red-600 text-white rounded-[3px] px-[12px] py-[5px] text-[12px] hover:bg-red-700 transition-colors focus-visible:outline-2 focus-visible:outline-red-400 focus-visible:outline-offset-2"
            >
              {t("pages.reportProblem.draft.delete")}?
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="border border-line bg-surface text-ink rounded-[3px] px-[12px] py-[5px] text-[12px] hover:border-line-2 transition-colors"
            >
              ×
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function SavedDraftsSection({ drafts, onLoad, onDelete }: {
  drafts: FeedbackDraftSummary[];
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="mt-8" aria-labelledby="section-saved">
      <SectionTitle id="section-saved">{t("pages.reportProblem.saved.title")}</SectionTitle>
      {drafts.length === 0 ? (
        <p className="text-ink-3 text-[13px] leading-relaxed py-2">
          —
        </p>
      ) : (
        <div className="space-y-3">
          {drafts.map((draft) => (
            <article key={draft.id} className="bg-panel border border-line rounded-[6px] px-4 py-3 flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <div className="font-mono text-[11px] text-ink-3">
                    {enumLabel('feedbackType', draft.type, t)} · {draft.createdAt}
                  </div>
                  {draft.status === "submitted" && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded-[2px] text-[10px] font-medium border border-green-200 bg-green-50 text-green-700">
                      {t("pages.reportProblem.draft.sentBadge")}
                    </span>
                  )}
                </div>
                <div className="text-ink text-sm truncate">{draft.title}</div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onLoad(draft.id)}
                  className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
                >
                  {t("pages.reportProblem.saved.load")}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(draft.id)}
                  className="border border-red-200 text-red-600 rounded-[3px] px-[10px] py-[6px] text-[12px] hover:bg-red-50 transition-colors focus-visible:outline-2 focus-visible:outline-red-400 focus-visible:outline-offset-2"
                >
                  {t("pages.reportProblem.draft.delete")}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Channel ladder (Slice 3, spec §4/§11) ─────────────────────────────────────

function ChannelSubmitArea({ draft, channels, onSubmitIngest, onSubmitGithub, onOpenEmail, onExportFile, onMarkSent }: {
  draft: DraftRecord;
  channels: FeedbackChannelStatusData[] | null;
  onSubmitIngest: () => void;
  onSubmitGithub: () => void;
  onOpenEmail: () => void;
  onExportFile: () => void;
  onMarkSent: (via: "email" | "file") => void;
}) {
  const { t } = useTranslation();
  const byId = useMemo(() => {
    const m = new Map<FeedbackChannelStatusData["id"], FeedbackChannelStatusData>();
    for (const c of channels ?? []) m.set(c.id, c);
    return m;
  }, [channels]);
  const submitted = draft.status === "submitted";

  const renderChannelButton = (id: FeedbackChannelStatusData["id"]) => {
    const status = byId.get(id);
    const available = status?.available ?? false;

    // email / file: 依赖客户端动作(打开邮件 / 导出),恒可尝试。
    if (id === "email") {
      return (
        <div key="email" className="space-y-1">
          <button
            type="button"
            onClick={onOpenEmail}
            className="w-full border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[8px] text-[13px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("pages.reportProblem.channel.email")}
          </button>
          {!submitted && (
            <button
              type="button"
              onClick={() => onMarkSent("email")}
              className="text-[11px] text-ink-3 hover:text-gov underline underline-offset-2 text-left"
            >
              {t("pages.reportProblem.draft.markAsSent")}
            </button>
          )}
        </div>
      );
    }

    if (id === "file") {
      return (
        <div key="file" className="space-y-1">
          <button
            type="button"
            onClick={onExportFile}
            className="w-full border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[8px] text-[13px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
          >
            {t("pages.reportProblem.channel.file")}
          </button>
          {!submitted && (
            <button
              type="button"
              onClick={() => onMarkSent("file")}
              className="text-[11px] text-ink-3 hover:text-gov underline underline-offset-2 text-left"
            >
              {t("pages.reportProblem.draft.markAsSent")}
            </button>
          )}
        </div>
      );
    }

    // ingest / github: 服务端通道,需探测可用性(rc-9: 禁用显示原因 + nextAction)。
    const isIngest = id === "ingest";
    const label = isIngest ? t("pages.reportProblem.channel.ingest") : t("pages.reportProblem.channel.github");
    const onClick = isIngest ? onSubmitIngest : onSubmitGithub;
    return (
      <div key={id} className="space-y-1">
        <button
          type="button"
          disabled={!available}
          onClick={onClick}
          className={
            available
              ? "w-full border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[8px] text-[13px] font-medium hover:bg-gov-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              : "w-full border border-line bg-surface text-ink-4 rounded-[3px] px-[14px] py-[8px] text-[13px] cursor-not-allowed"
          }
        >
          {label}
        </button>
        {!available && (status?.reason || status?.nextAction) && (
          <p className="text-[11px] text-ink-3 leading-snug">
            {t("pages.reportProblem.channel.disablingReason", { reason: status?.reason ?? "" })}
            {status?.nextAction ? ` · ${status.nextAction}` : ""}
          </p>
        )}
      </div>
    );
  };

  return (
    <section className="mt-8" aria-labelledby="section-channel">
      <SectionTitle id="section-channel">{t("pages.reportProblem.channel.title")}</SectionTitle>
      <p className="text-ink-3 text-[13px] leading-relaxed mb-4">
        {t("pages.reportProblem.channel.description")}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {CHANNEL_ORDER.map(renderChannelButton)}
      </div>
    </section>
  );
}

function ConfirmSubmitDialog({ draft, channel, open, busy, onConfirm, onCancel }: {
  draft: DraftRecord;
  channel: "ingest" | "github";
  open: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("pages.reportProblem.channel.confirmTitle")}</DialogTitle>
          <DialogDescription>
            {channel === "ingest"
              ? t("pages.reportProblem.channel.confirmDescription")
              : t("pages.reportProblem.channel.github")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-auto space-y-2">
          <div className="font-mono text-[12px] text-ink-3">{draft.title}</div>
          <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
            {t("pages.reportProblem.channel.confirmBodyLabel")}
          </h3>
          <pre className="whitespace-pre-wrap text-ink-2 text-[13px] leading-relaxed bg-surface border border-line rounded-[3px] p-3 max-h-[320px] overflow-auto">
            {draft.outputs.markdown}
          </pre>
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 disabled:opacity-50"
          >
            {t("pages.reportProblem.channel.confirmCancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? t("pages.reportProblem.form.submitting") : t("pages.reportProblem.channel.confirmSubmit")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page component ──────────────────────────────────────────────────────

type LoadingState = "loading" | "loaded" | "error";

export function ReportProblemPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [form, setForm] = useState<FormState>(() => ({
    ...INITIAL_FORM,
    type: defaultTypeFromParams(searchParams),
  }));
  const [drafts, setDrafts] = useState<FeedbackDraftSummary[]>([]);
  const [currentDraft, setCurrentDraft] = useState<DraftRecord | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  // ── Channel ladder state (Slice 3) ──
  const [channels, setChannels] = useState<FeedbackChannelStatusData[] | null>(null);
  const [confirmCtx, setConfirmCtx] = useState<{ channel: "ingest" | "github" } | null>(null);
  const [submittingChannel, setSubmittingChannel] = useState(false);

  const contextFromUrl = useMemo(
    () => buildFeedbackContextFromSearchParams(searchParams),
    [searchParams],
  );

  const areaFromUrl = useMemo(() => deriveFeedbackArea(contextFromUrl), [contextFromUrl]);

  // 类型切换时:有细节字段的类型自动展开"补充细节"。
  useEffect(() => {
    setShowDetails(PER_TYPE_DETAIL_FIELDS[form.type].length > 0);
  }, [form.type]);

  // ── Load drafts + channels on mount ─────────────────────────────────────
  const loadDrafts = useCallback(async () => {
    const result = await listFeedbackReports();
    if (!result.success) {
      setLoadError(result.error ?? "Failed to load drafts");
      setLoadingState("loaded");
      return;
    }
    const validated = validateDraftsList(result.data);
    if (!validated.ok) {
      setLoadError(validated.reason);
      setDrafts([]);
      setLoadingState("loaded");
      return;
    }
    setDrafts(validated.drafts);
    setLoadError(null);
    setLoadingState("loaded");
  }, []);

  const loadChannels = useCallback(async () => {
    const result = await fetchFeedbackChannels();
    if (!result.success || !result.data) {
      setChannels(null);
      return;
    }
    setChannels(result.data.channels);
  }, []);

  useEffect(() => {
    loadDrafts();
    loadChannels();
  }, [loadDrafts, loadChannels]);

  // ── Form handlers ────────────────────────────────────────────────────────
  const handleFieldChange = useCallback(<K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const buildInput = useCallback(() => {
    const base = {
      type: form.type as FeedbackType,
      title: form.title.trim(),
      description: form.description.trim(),
      stepsToReproduce: form.stepsToReproduce.trim() || undefined,
      expectedBehavior: form.expectedBehavior.trim() || undefined,
      actualBehavior: form.actualBehavior.trim() || undefined,
      // 类型化新字段(全部可选,按 type 条件提交)
      goal: form.goal.trim() || undefined,
      stuckAt: form.stuckAt.trim() || undefined,
      job: form.job.trim() || undefined,
      currentWorkaround: form.currentWorkaround.trim() || undefined,
      sawWhat: form.sawWhat.trim() || undefined,
      whereSeen: form.whereSeen.trim() || undefined,
      frequency: form.frequency ?? undefined,
      blockingLevel: form.blockingLevel ?? undefined,
      ...(areaFromUrl ? { area: areaFromUrl } : {}),
      ...(contextFromUrl?.taskId ? { taskId: contextFromUrl.taskId } : {}),
      ...(contextFromUrl ? { context: contextFromUrl } : {}),
    };
    return base;
  }, [form, areaFromUrl, contextFromUrl]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.title.trim() || !form.description.trim()) {
      toast.error(t("pages.reportProblem.errors.missingRequired"));
      return;
    }

    setForm((prev) => ({ ...prev, submitting: true }));

    try {
      const [configSettled, lifecycleSettled, healthSettled] = await Promise.allSettled([
        fetchConfigSummary(),
        request('/api/v1/lifecycle/state'),
        request('/api/health'),
      ]);
      const diagnostics = buildFeedbackDiagnostics(
        configSettled,
        lifecycleSettled,
        healthSettled,
      );

      const result = await createFeedbackReport(buildInput(), diagnostics);

      if (!result.success) {
        toast.error(getErrorMessage(result, t("pages.reportProblem.errors.createFailed")));
        setForm((prev) => ({ ...prev, submitting: false }));
        return;
      }

      let parsed: DraftRecord | null = parseEnvelopeReport(result.data);
      if (parsed === null && isRecord(result.data) && Object.hasOwn(result.data, "report")) {
        parsed = parseDraftRecord(result.data["report"]);
      }

      if (parsed === null) {
        toast.error(t("pages.reportProblem.errors.createFailed"));
        setForm((prev) => ({ ...prev, submitting: false }));
        return;
      }
      setCurrentDraft(parsed);
      toast.success(t("pages.reportProblem.toast.draftCreated"));

      setForm((prev) => ({
        ...INITIAL_FORM,
        type: prev.type,
        frequency: undefined,
        blockingLevel: undefined,
        submitting: false,
      }));
      setShowPreview(false);
      await loadDrafts();
    } catch {
      toast.error(t("pages.reportProblem.errors.createFailed"));
    } finally {
      setForm((prev) => ({ ...prev, submitting: false }));
    }
  }, [form, t, loadDrafts, buildInput]);

  // ── Draft actions ────────────────────────────────────────────────────────
  const handleLoadDraft = useCallback(async (id: string) => {
    const result = await getFeedbackReport(id);
    if (!result.success) {
      toast.error(t("pages.reportProblem.toast.loadFailed"));
      return;
    }
    const parsed = parseEnvelopeReport(result.data);
    if (parsed === null) {
      toast.error(t("pages.reportProblem.toast.loadFailed"));
      return;
    }
    setCurrentDraft(parsed);
    setForm({
      type: parsed.type,
      title: parsed.title,
      description: parsed.userText.description,
      stepsToReproduce: parsed.userText.stepsToReproduce ?? "",
      expectedBehavior: parsed.userText.expectedBehavior ?? "",
      actualBehavior: parsed.userText.actualBehavior ?? "",
      frequency: parsed.userText.frequency,
      blockingLevel: parsed.userText.blockingLevel,
      goal: parsed.userText.goal ?? "",
      stuckAt: parsed.userText.stuckAt ?? "",
      job: parsed.userText.job ?? "",
      currentWorkaround: parsed.userText.currentWorkaround ?? "",
      sawWhat: parsed.userText.sawWhat ?? "",
      whereSeen: parsed.userText.whereSeen ?? "",
      submitting: false,
    });
  }, [t]);

  const handleCopyMarkdown = useCallback(async (draft: DraftRecord) => {
    try {
      if (!draft.outputs.markdown) return;
      await navigator.clipboard.writeText(draft.outputs.markdown);
      toast.success(t("pages.reportProblem.toast.markdownCopied"));
    } catch {
      toast.error(t("pages.reportProblem.toast.copyFailed"));
    }
  }, [t]);

  const handleCopyEmail = useCallback(async (draft: DraftRecord) => {
    try {
      if (!draft.outputs.emailText) return;
      await navigator.clipboard.writeText(draft.outputs.emailText);
      toast.success(t("pages.reportProblem.toast.emailCopied"));
    } catch {
      toast.error(t("pages.reportProblem.toast.copyFailed"));
    }
  }, [t]);

  const handleOpenGithub = useCallback((draft: DraftRecord) => {
    if (draft.outputs.githubIssueUrl) {
      window.open(draft.outputs.githubIssueUrl, "_blank");
    }
  }, []);

  const handleOpenEmail = useCallback((draft: DraftRecord) => {
    if (draft.outputs.mailtoUrl) {
      window.open(draft.outputs.mailtoUrl, "_blank");
    }
  }, []);

  const handleExportFile = useCallback((draft: DraftRecord) => {
    const blob = new Blob([draft.outputs.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `PD-feedback-${draft.id}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  const refreshDraft = useCallback(async (id: string) => {
    const result = await getFeedbackReport(id);
    if (result.success) {
      const parsed = parseEnvelopeReport(result.data);
      if (parsed) setCurrentDraft(parsed);
    }
  }, []);

  const handleSubmitChannel = useCallback(async (channel: "ingest" | "github") => {
    const draft = currentDraft;
    if (!draft) return;
    setSubmittingChannel(true);
    try {
      const result = await submitFeedbackReport(draft.id, channel);
      if (!result.success) {
        toast.error(getErrorMessage(result, t("pages.reportProblem.toast.submitFailed")));
        return;
      }
      await refreshDraft(draft.id);
      await loadDrafts();
      const data = result.data;
      if (data?.writeBackFailed) {
        toast.error(t("pages.reportProblem.channel.writeBackNote"));
      } else if (data?.alreadySubmitted) {
        toast.info(t("pages.reportProblem.channel.alreadySubmitted"));
      } else {
        toast.success(t("pages.reportProblem.toast.submitSucceeded", { trackingId: data?.trackingId ?? "" }));
      }
    } catch {
      toast.error(t("pages.reportProblem.toast.submitFailed"));
    } finally {
      setSubmittingChannel(false);
      setConfirmCtx(null);
    }
  }, [currentDraft, t, refreshDraft, loadDrafts]);

  const handleMarkSent = useCallback(async (via: "email" | "file") => {
    const draft = currentDraft;
    if (!draft) return;
    const result = await markFeedbackReportSent(draft.id, via);
    if (!result.success) {
      toast.error(getErrorMessage(result, t("pages.reportProblem.toast.submitFailed")));
      return;
    }
    toast.success(t("pages.reportProblem.toast.markSentSucceeded"));
    await refreshDraft(draft.id);
    await loadDrafts();
  }, [currentDraft, t, refreshDraft, loadDrafts]);

  const handleDeleteDraft = useCallback(async (id: string) => {
    const result = await deleteFeedbackReport(id);
    if (!result.success) {
      toast.error(t("pages.reportProblem.toast.deleteFailed"));
      return;
    }
    toast.success(t("pages.reportProblem.toast.draftDeleted"));
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    if (currentDraft?.id === id) {
      setCurrentDraft(null);
    }
  }, [t, currentDraft]);

  // ── Loading state ────────────────────────────────────────────────────────
  if (loadingState === "loading") {
    return (
      <PageShell>
        <PageLoading cardCount={3} label={t("common.loading")} />
      </PageShell>
    );
  }

  // ── Error state (ERR-002: degradation with reason) ───────────────────────
  if (loadingState === "error") {
    return (
      <PageShell>
        <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
          {t("pages.reportProblem.eyebrow")}
        </div>
        <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
          {t("pages.reportProblem.title")}
        </h1>
        <div className="mt-6 p-4 bg-panel border border-line rounded-[6px] text-ink-2 text-sm">
          <p>{t("pages.reportProblem.loadError")}</p>
          {loadError && (
            <p className="mt-2 text-ink-4 text-[13px] font-mono">{loadError}</p>
          )}
        </div>
      </PageShell>
    );
  }

  const detailFields = PER_TYPE_DETAIL_FIELDS[form.type];

  const renderDetailField = (key: keyof FormState) => {
    if (key === "frequency") {
      const label = t("pages.reportProblem.form.frequencyLabel");
      return (
        <div key="frequency">
          <label htmlFor="feedback-frequency" className="block text-ink-2 text-[13px] mb-1.5">{label}</label>
          <select
            id="feedback-frequency"
            value={form.frequency ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") handleFieldChange("frequency", undefined);
              else if (VALID_FREQUENCIES.has(v)) handleFieldChange("frequency", v as FeedbackFrequency);
            }}
            className="border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov"
          >
            <option value="">{t("pages.reportProblem.form.frequencyNotSet")}</option>
            {FREQUENCY_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {t(`pages.reportProblem.form.frequency${f.charAt(0).toUpperCase() + f.slice(1)}` as `pages.reportProblem.form.frequency${string}`)}
              </option>
            ))}
          </select>
        </div>
      );
    }
    if (key === "blockingLevel") {
      const label = t("pages.reportProblem.form.blockingLevelLabel");
      return (
        <div key="blockingLevel">
          <label htmlFor="feedback-blocking" className="block text-ink-2 text-[13px] mb-1.5">{label}</label>
          <select
            id="feedback-blocking"
            value={form.blockingLevel ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") handleFieldChange("blockingLevel", undefined);
              else if (VALID_BLOCKING.has(v)) handleFieldChange("blockingLevel", v as FeedbackBlockingLevel);
            }}
            className="border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov"
          >
            <option value="">{t("pages.reportProblem.form.blockingLevelNotSet")}</option>
            {BLOCKING_OPTIONS.map((b) => (
              <option key={b} value={b}>
                {t(`pages.reportProblem.form.blockingLevel${b.charAt(0).toUpperCase() + b.slice(1)}` as `pages.reportProblem.form.blockingLevel${string}`)}
              </option>
            ))}
          </select>
        </div>
      );
    }
    const value = form[key];
    const label = t(DETAIL_FIELD_LABEL[key] ?? "pages.reportProblem.form.descriptionLabel");
    return (
      <div key={key}>
        <label htmlFor={`feedback-${key}`} className="block text-ink-2 text-[13px] mb-1.5">{label}</label>
        <textarea
          id={`feedback-${key}`}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => handleFieldChange(key, e.target.value as FormState[typeof key])}
          rows={key === "stepsToReproduce" ? 3 : 2}
          className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov resize-y"
        />
      </div>
    );
  };

  // ── Loaded state ─────────────────────────────────────────────────────────
  return (
    <PageShell>
      <div className="animate-[pdFadeIn_400ms_ease-out]">
      {/* Layer 1: Conclusion — eyebrow + title + subtitle */}
      <div className="font-mono text-[12px] tracking-[0.14em] text-ink-3 uppercase mb-3">
        {t("pages.reportProblem.eyebrow")}
      </div>
      <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
        {t("pages.reportProblem.title")}
      </h1>
      <p className="text-ink-3 text-[14px] max-w-[760px] leading-relaxed mb-7">
        {t("pages.reportProblem.subtitle")}
      </p>

      <NoAutoUploadBanner />

      {/* Section 1: Feedback Form */}
      <section aria-labelledby="section-form">
        <SectionTitle id="section-form">{t("pages.reportProblem.form.title")}</SectionTitle>
        <p className="text-ink-3 text-[13px] leading-relaxed mb-4">
          {t("pages.reportProblem.form.description")}
        </p>

        <form onSubmit={handleSubmit} className="bg-panel border border-line rounded-[6px] p-5 space-y-4">
          {/* Type selector */}
          <div>
            <label htmlFor="feedback-type" className="block text-ink-2 text-[13px] mb-1.5">
              {t("pages.reportProblem.form.type")}
            </label>
            <select
              id="feedback-type"
              value={form.type}
              onChange={(e) => {
                const val = e.target.value;
                if (VALID_FEEDBACK_TYPES.has(val)) {
                  setForm((prev) => ({ ...prev, type: val as FeedbackType, frequency: undefined, blockingLevel: undefined }));
                }
              }}
              className="border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov"
            >
              {FEEDBACK_TYPES.map((ft) => (
                <option key={ft} value={ft}>
                  {t(`pages.reportProblem.form.types.${ft}`)}
                </option>
              ))}
            </select>
          </div>

          {/* Title */}
          <div>
            <label htmlFor="feedback-title" className="block text-ink-2 text-[13px] mb-1.5">
              {t("pages.reportProblem.form.titleLabel")}
            </label>
            <input
              id="feedback-title"
              type="text"
              value={form.title}
              onChange={(e) => handleFieldChange("title", e.target.value)}
              className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov"
            />
          </div>

          {/* Description (恒显必填) */}
          <div>
            <label htmlFor="feedback-description" className="block text-ink-2 text-[13px] mb-1.5">
              {t("pages.reportProblem.form.descriptionLabel")}
            </label>
            <textarea
              id="feedback-description"
              value={form.description}
              onChange={(e) => handleFieldChange("description", e.target.value)}
              rows={4}
              className="w-full border border-line bg-surface rounded-[3px] px-3 py-2 text-sm text-ink focus:outline-none focus:border-gov focus:ring-1 focus:ring-gov resize-y"
            />
          </div>

          {/* 渐进披露:类型条件字段折叠在"补充细节"下(spec §6) */}
          {detailFields.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowDetails((prev) => !prev)}
                className="text-gov text-[13px] font-medium underline underline-offset-2 hover:text-gov-2 transition-colors"
              >
                {showDetails ? t("pages.reportProblem.form.detailsHide") : t("pages.reportProblem.form.detailsToggle")}
              </button>
            </div>
          )}

          {showDetails && (
            <div className="space-y-4 border-t border-line pt-4">{detailFields.map(renderDetailField)}</div>
          )}

          {/* Submit */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={form.submitting}
              className="border border-gov bg-gov text-paper rounded-[3px] px-[14px] py-[6px] text-[12.5px] font-medium hover:bg-gov-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
            >
              {form.submitting ? t("pages.reportProblem.form.submitting") : t("pages.reportProblem.form.submit")}
            </button>
            {currentDraft && (
              <button
                type="button"
                onClick={() => setShowPreview((prev) => !prev)}
                className="border border-line bg-surface text-ink rounded-[3px] px-[14px] py-[6px] text-[12.5px] hover:border-line-2 transition-colors focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2"
              >
                {showPreview
                  ? t("pages.reportProblem.form.hidePreview")
                  : t("pages.reportProblem.form.showPreview")}
              </button>
            )}
          </div>
        </form>

        {/* Markdown preview */}
        {showPreview && currentDraft && (
          <div className="mt-4 bg-panel border border-line rounded-[6px] p-4">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-3">
              Markdown
            </h3>
            <pre className="whitespace-pre-wrap text-ink-2 text-[13px] leading-relaxed bg-surface border border-line rounded-[3px] p-3 max-h-[400px] overflow-auto">
              {currentDraft.outputs.markdown}
            </pre>
          </div>
        )}
      </section>

      {/* Section 2: Privacy Boundary */}
      <PrivacySection draft={currentDraft} />

      {/* Channel ladder — 仅在存在当前草稿时展示(spec §4/§11.2) */}
      {currentDraft && (
        <ChannelSubmitArea
          draft={currentDraft}
          channels={channels}
          onSubmitIngest={() => setConfirmCtx({ channel: "ingest" })}
          onSubmitGithub={() => setConfirmCtx({ channel: "github" })}
          onOpenEmail={() => handleOpenEmail(currentDraft)}
          onExportFile={() => handleExportFile(currentDraft)}
          onMarkSent={handleMarkSent}
        />
      )}

      {/* Current draft card */}
      {currentDraft && (
        <section className="mt-8" aria-labelledby="section-current-draft">
          <SectionTitle id="section-current-draft">{t("pages.reportProblem.draft.title")}</SectionTitle>
          <DraftCard
            draft={currentDraft}
            onCopyMarkdown={() => handleCopyMarkdown(currentDraft)}
            onCopyEmail={() => handleCopyEmail(currentDraft)}
            onOpenGithub={() => handleOpenGithub(currentDraft)}
            onOpenEmail={() => handleOpenEmail(currentDraft)}
            onDelete={() => handleDeleteDraft(currentDraft.id)}
          />
        </section>
      )}

      {/* Section 3: Saved Drafts */}
      {loadError && (
        <div className="mt-4 p-3 bg-panel border border-amber/20 rounded-[6px] text-ink-2 text-[13px]">
          <p>{t("pages.reportProblem.loadError")}</p>
          <p className="mt-1 text-ink-4 text-[12px] font-mono">{loadError}</p>
        </div>
      )}
      <SavedDraftsSection
        drafts={drafts}
        onLoad={handleLoadDraft}
        onDelete={handleDeleteDraft}
      />

      {/* Footer */}
      <footer className="mt-12 pt-6 border-t border-line text-ink-3 text-[13px]">
        {t("pages.reportProblem.privacy.guarantee")}
      </footer>

      {/* 确认面板(同意门,spec §11.1) */}
      {currentDraft && confirmCtx && (
        <ConfirmSubmitDialog
          draft={currentDraft}
          channel={confirmCtx.channel}
          open
          busy={submittingChannel}
          onConfirm={() => handleSubmitChannel(confirmCtx.channel)}
          onCancel={() => setConfirmCtx(null)}
        />
      )}
      </div>
    </PageShell>
  );
}