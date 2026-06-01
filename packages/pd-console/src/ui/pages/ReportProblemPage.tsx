// ReportProblemPage.tsx
// Console-first MVP seed feedback report generator (PRI-285, Scheme B).
//
// This page NEVER uploads the report anywhere automatically. The user fills
// in the form, the browser calls POST /api/feedback/reports, and the server
// writes the draft to <workspace>/.pd/feedback/drafts/<id>.json. The page
// then offers three local-only export actions:
//   1. Copy Markdown to clipboard
//   2. Copy email-ready plain text to clipboard
//   3. Open a pre-filled GitHub issue URL (the user still has to click Submit)
//
// The page can be deep-linked via `?source=<tag>&message=<text>` so the error
// boundary can route here with a pre-filled description.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Copy, ExternalLink, Save, Trash2, Eye, EyeOff } from "lucide-react";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { createFeedbackReport, listFeedbackReports, getFeedbackReport, deleteFeedbackReport, type ApiResponse, type FeedbackDraftSummary, type FeedbackReportEnvelope, type FeedbackDraftEnvelope, type FeedbackDeleteEnvelope, type FeedbackDraftsListEnvelope } from "../api.js";
import {
  parseDraftRecord,
  parseDraftSummary,
  parseEnvelopeReport,
  getErrorMessage,
  type DraftRecord,
  type FeedbackType,
  type UserSeverity,
} from "./ReportProblemValidators.js";

type FeedbackTypeWithEmpty = FeedbackType | "";
type UserSeverityWithEmpty = UserSeverity | "";

type FormState = {
  type: FeedbackTypeWithEmpty;
  userSeverity: UserSeverityWithEmpty;
};

const FEEDBACK_TYPES: FeedbackType[] = ["bug", "confusing", "privacy_concern", "feature_request", "other"];

async function tryCopyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ReportProblemPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();

  // Form state
  const initialMessage = searchParams.get("message") ?? "";
  const sourceFromUrl = searchParams.get("source") ?? "";
  const [type, setType] = useState<FeedbackType>("bug");
  const [title, setTitle] = useState<string>("");
  const [description, setDescription] = useState<string>(initialMessage);
  const [stepsToReproduce, setStepsToReproduce] = useState<string>("");
  const [expectedBehavior, setExpectedBehavior] = useState<string>("");
  const [actualBehavior, setActualBehavior] = useState<string>("");
  const [userSeverity, setUserSeverity] = useState<UserSeverity | "">("");
  const [showPreview, setShowPreview] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Result state
  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [drafts, setDrafts] = useState<FeedbackDraftSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Refresh the draft list on mount
  useEffect(() => {
    void refreshDrafts();
  }, []);

  const refreshDrafts = async (): Promise<void> => {
    const result: ApiResponse<FeedbackDraftsListEnvelope> = await listFeedbackReports();
    if (result.success && result.data) {
      const parsed: FeedbackDraftSummary[] = [];
      for (const item of result.data.drafts) {
        const p = parseDraftSummary(item);
        if (p) parsed.push(p);
      }
      setDrafts(parsed);
    }
  };

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !description.trim()) {
      setError(t("pages:reportProblem.errors.missingRequired"));
      return;
    }
    setSubmitting(true);
    try {
      const input: Record<string, unknown> = {
        type,
        title: title.trim(),
        description: description.trim(),
      };
      if (stepsToReproduce.trim()) input.stepsToReproduce = stepsToReproduce.trim();
      if (expectedBehavior.trim()) input.expectedBehavior = expectedBehavior.trim();
      if (actualBehavior.trim()) input.actualBehavior = actualBehavior.trim();
      if (userSeverity) input.userSeverity = userSeverity;
      if (sourceFromUrl) input.context = { source: "console", page: "/report-problem" };

      const result: ApiResponse<FeedbackReportEnvelope> = await createFeedbackReport(input, {});
      if (result.success !== true || !result.data) {
        setError(getErrorMessage(result, t("pages:reportProblem.errors.createFailed")));
        return;
      }
      const parsedDraft = parseDraftRecord(result.data.report);
      if (!parsedDraft) {
        setError(t("pages:reportProblem.errors.createFailed"));
        return;
      }
      setDraft(parsedDraft);
      toast.success(t("pages:reportProblem.toast.draftCreated"));
      await refreshDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onCopyMarkdown = async (): Promise<void> => {
    if (!draft) return;
    const ok = await tryCopyToClipboard(draft.outputs.markdown);
    if (ok) toast.success(t("pages:reportProblem.toast.markdownCopied"));
    else toast.error(t("pages:reportProblem.toast.copyFailed"));
  };

  const onCopyEmail = async (): Promise<void> => {
    if (!draft) return;
    const ok = await tryCopyToClipboard(draft.outputs.emailText);
    if (ok) toast.success(t("pages:reportProblem.toast.emailCopied"));
    else toast.error(t("pages:reportProblem.toast.copyFailed"));
  };

  const onOpenGithub = (): void => {
    if (!draft) return;
    window.open(draft.outputs.githubIssueUrl, "_blank", "noopener,noreferrer");
  };

  const onLoadDraft = async (id: string): Promise<void> => {
    const result: ApiResponse<FeedbackDraftEnvelope> = await getFeedbackReport(id);
    if (result.success === true && result.data) {
      const parsed = parseEnvelopeReport(result.data);
      if (!parsed) {
        toast.error(t("pages:reportProblem.toast.loadFailed"));
        return;
      }
      setDraft(parsed);
      setTitle(parsed.title);
      setType(parsed.type);
      const ut = parsed.userText;
      setDescription(ut.description);
      setStepsToReproduce(ut.stepsToReproduce ?? "");
      setExpectedBehavior(ut.expectedBehavior ?? "");
      setActualBehavior(ut.actualBehavior ?? "");
      setUserSeverity(ut.userSeverity ?? "");
    } else {
      toast.error(getErrorMessage(result, t("pages:reportProblem.toast.loadFailed")));
    }
  };

  const onDeleteDraft = async (id: string): Promise<void> => {
    const result: ApiResponse<FeedbackDeleteEnvelope> = await deleteFeedbackReport(id);
    if (result.success === true) {
      toast.success(t("pages:reportProblem.toast.draftDeleted"));
      if (draft?.id === id) setDraft(null);
      await refreshDrafts();
    } else {
      toast.error(getErrorMessage(result, t("pages:reportProblem.toast.deleteFailed")));
    }
  };

  const includedSections = useMemo(
    () => draft?.privacy.includedSections ?? [],
    [draft],
  );
  const excludedByDefault = useMemo(
    () => draft?.privacy.excludedByDefault ?? [],
    [draft],
  );
  const redactionNotes = useMemo(
    () => draft?.privacy.redactionNotes ?? [],
    [draft],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("pages:reportProblem.title")}
        description={t("pages:reportProblem.description")}
      />

      {sourceFromUrl ? (
        <div className="text-xs text-muted-foreground">
          {t("pages:reportProblem.deepLinked", { source: sourceFromUrl })}
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("pages:reportProblem.form.title")}</CardTitle>
            <CardDescription>{t("pages:reportProblem.form.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4" aria-label="feedback-form">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label htmlFor="feedback-type" className="text-sm font-medium">
                    {t("pages:reportProblem.form.type")}
                  </label>
                  <Select value={type} onValueChange={(v) => setType(v as FeedbackType)}>
                    <SelectTrigger id="feedback-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FEEDBACK_TYPES.map((tt) => (
                        <SelectItem key={tt} value={tt}>
                          {t(`pages:reportProblem.form.types.${tt}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label htmlFor="feedback-severity" className="text-sm font-medium">
                    {t("pages:reportProblem.form.severity")}
                  </label>
                  <Select value={userSeverity || "none"} onValueChange={(v) => setUserSeverity(v === "none" ? "" : (v as UserSeverity))}>
                    <SelectTrigger id="feedback-severity">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("pages:reportProblem.form.severityNotSet")}</SelectItem>
                      <SelectItem value="low">{t("pages:reportProblem.form.severityLow")}</SelectItem>
                      <SelectItem value="medium">{t("pages:reportProblem.form.severityMedium")}</SelectItem>
                      <SelectItem value="high">{t("pages:reportProblem.form.severityHigh")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="feedback-title" className="text-sm font-medium">
                  {t("pages:reportProblem.form.titleLabel")}
                </label>
                <Input
                  id="feedback-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  required
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="feedback-description" className="text-sm font-medium">
                  {t("pages:reportProblem.form.descriptionLabel")}
                </label>
                <textarea
                  id="feedback-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  required
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="feedback-steps" className="text-sm font-medium">
                  {t("pages:reportProblem.form.stepsLabel")}
                </label>
                <textarea
                  id="feedback-steps"
                  value={stepsToReproduce}
                  onChange={(e) => setStepsToReproduce(e.target.value)}
                  rows={3}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label htmlFor="feedback-expected" className="text-sm font-medium">
                    {t("pages:reportProblem.form.expectedLabel")}
                  </label>
                  <textarea
                    id="feedback-expected"
                    value={expectedBehavior}
                    onChange={(e) => setExpectedBehavior(e.target.value)}
                    rows={2}
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="feedback-actual" className="text-sm font-medium">
                    {t("pages:reportProblem.form.actualLabel")}
                  </label>
                  <textarea
                    id="feedback-actual"
                    value={actualBehavior}
                    onChange={(e) => setActualBehavior(e.target.value)}
                    rows={2}
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                </div>
              </div>

              {error ? (
                <div role="alert" className="text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={submitting}>
                  <Save className="h-4 w-4 mr-2" />
                  {submitting ? t("pages:reportProblem.form.submitting") : t("pages:reportProblem.form.submit")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowPreview((v) => !v)}
                >
                  {showPreview ? (
                    <>
                      <EyeOff className="h-4 w-4 mr-2" />
                      {t("pages:reportProblem.form.hidePreview")}
                    </>
                  ) : (
                    <>
                      <Eye className="h-4 w-4 mr-2" />
                      {t("pages:reportProblem.form.showPreview")}
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("pages:reportProblem.privacy.title")}</CardTitle>
            <CardDescription>{t("pages:reportProblem.privacy.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <h4 className="font-medium mb-1">{t("pages:reportProblem.privacy.included")}</h4>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                {includedSections.map((s) => (
                  <li key={`i-${s}`}>{s}</li>
                ))}
                {includedSections.length === 0 ? (
                  <li className="text-xs italic">{t("pages:reportProblem.privacy.submitFirst")}</li>
                ) : null}
              </ul>
            </div>
            <div>
              <h4 className="font-medium mb-1">{t("pages:reportProblem.privacy.excluded")}</h4>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                {excludedByDefault.map((s) => (
                  <li key={`e-${s}`}>{s}</li>
                ))}
              </ul>
            </div>
            {redactionNotes.length > 0 ? (
              <div>
                <h4 className="font-medium mb-1">{t("pages:reportProblem.privacy.notes")}</h4>
                <ul className="list-disc list-inside text-muted-foreground space-y-1">
                  {redactionNotes.map((n, i) => (
                    <li key={`n-${i}`}>{n}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("pages:reportProblem.privacy.guarantee")}
            </p>
          </CardContent>
        </Card>
      </div>

      {draft ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("pages:reportProblem.draft.title")}</CardTitle>
            <CardDescription>
              {t("pages:reportProblem.draft.savedAt", { id: draft.id, at: draft.createdAt })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={onCopyMarkdown} variant="default">
                <Copy className="h-4 w-4 mr-2" />
                {t("pages:reportProblem.draft.copyMarkdown")}
              </Button>
              <Button onClick={onCopyEmail} variant="outline">
                <Copy className="h-4 w-4 mr-2" />
                {t("pages:reportProblem.draft.copyEmail")}
              </Button>
              <Button onClick={onOpenGithub} variant="outline">
                <ExternalLink className="h-4 w-4 mr-2" />
                {t("pages:reportProblem.draft.openGithub")}
              </Button>
              <Button onClick={() => void onDeleteDraft(draft.id)} variant="ghost">
                <Trash2 className="h-4 w-4 mr-2" />
                {t("pages:reportProblem.draft.delete")}
              </Button>
            </div>
            {showPreview ? (
              <pre className="rounded-md border border-border bg-muted/40 p-4 text-xs whitespace-pre-wrap break-words max-h-[480px] overflow-y-auto">
                {draft.outputs.markdown}
              </pre>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {drafts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("pages:reportProblem.saved.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {drafts.map((d) => (
                <li key={d.id} className="flex items-center justify-between py-2">
                  <div>
                    <div className="font-medium">{d.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {d.type} · {d.createdAt}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => void onLoadDraft(d.id)}>
                      {t("pages:reportProblem.saved.load")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void onDeleteDraft(d.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
