import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SectionTitle } from "../../components/layout/section-title.js";
import {
  createDesignGateDeclaration,
  fetchDesignGateDeclaration,
  fetchDesignGateSessions,
  revokeDesignGateDeclaration,
  updateDesignGateDecision,
} from "../../api.js";
import type {
  DesignGateDeclaration,
  DesignGateObservedSession,
  DesignGateDecision,
  DesignGateAction,
} from "../../api.js";

type ApiFailure = { error: string; nextAction?: string; status?: number };

const decisionTranslationKey: Record<DesignGateDecision, string> = {
  approved: "approved",
  not_approved: "notApproved",
  not_required: "notRequired",
};

const actionTranslationKey: Record<DesignGateAction, string> = {
  read: "read",
  write: "write",
  execute: "execute",
};

function sessionKey(session: DesignGateObservedSession): string {
  return `${session.projectWorkspacePath}\u001f${session.hostSessionId}`;
}

function parsePaths(value: string): string[] {
  return value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
}

function errorFromResponse(response: { success: false; error: string; nextAction?: string; status?: number }): ApiFailure {
  return { error: response.error, nextAction: response.nextAction, status: response.status };
}

function fieldClass(): string {
  return "mt-1 w-full rounded-[4px] border border-line bg-surface px-3 py-2 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2";
}

function actionButtonClass(): string {
  return "rounded-[4px] border border-line px-3 py-2 text-[12.5px] font-medium text-ink transition-colors hover:border-line-2 focus-visible:outline-2 focus-visible:outline-gov focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
}

export function DesignGatePanel() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<DesignGateObservedSession[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [declaration, setDeclaration] = useState<DesignGateDeclaration | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [declarationLoading, setDeclarationLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [specPath, setSpecPath] = useState("");
  const [scopePaths, setScopePaths] = useState("");
  const [scopeActions, setScopeActions] = useState<DesignGateAction[]>(["write", "execute"]);
  const [newDecision, setNewDecision] = useState<DesignGateDecision>("not_approved");
  const declarationRequest = useRef(0);

  const selectedSession = useMemo(
    () => sessions.find((session) => sessionKey(session) === selectedKey) ?? null,
    [sessions, selectedKey],
  );

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setError(null);
    const result = await fetchDesignGateSessions();
    setSessionsLoading(false);
    if (!result.success) {
      setError(errorFromResponse(result));
      return;
    }
    setSessions(result.data.sessions);
    setSelectedKey((current) => result.data.sessions.some((session) => sessionKey(session) === current)
      ? current
      : result.data.sessions[0] ? sessionKey(result.data.sessions[0]) : "");
  }, []);

  const loadDeclaration = useCallback(async (session: DesignGateObservedSession) => {
    const requestNumber = ++declarationRequest.current;
    setDeclarationLoading(true);
    setError(null);
    const result = await fetchDesignGateDeclaration(session.projectWorkspacePath, session.hostSessionId);
    if (requestNumber !== declarationRequest.current) return;
    setDeclarationLoading(false);
    if (!result.success) {
      setError(errorFromResponse(result));
      setDeclaration(null);
      return;
    }
    setDeclaration(result.data.declaration);
  }, []);

  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => {
    if (selectedSession) void loadDeclaration(selectedSession);
    else {
      declarationRequest.current += 1;
      setDeclarationLoading(false);
      setDeclaration(null);
    }
  }, [selectedSession, loadDeclaration]);

  const runMutation = useCallback(async (
    mutation: () => Promise<{ success: true; data: { declaration: DesignGateDeclaration | null } } | { success: false; error: string; nextAction?: string; status?: number }>,
  ) => {
    setPending(true);
    setError(null);
    const result = await mutation();
    setPending(false);
    if (!result.success) {
      const failure = errorFromResponse(result);
      setError(failure);
      if (result.status === 409 && selectedSession) {
        await loadDeclaration(selectedSession);
        setError(failure);
      }
      return;
    }
    if (!result.data.declaration) {
      setError({ error: t("pages.controlCenter.designGate.invalidMutationResponse") });
      return;
    }
    setDeclaration(result.data.declaration);
  }, [loadDeclaration, selectedSession, t]);

  const createDeclaration = useCallback(async () => {
    if (!selectedSession) return;
    const paths = parsePaths(scopePaths);
    if (!specPath.trim() || paths.length === 0 || scopeActions.length === 0) {
      setError({ error: t("pages.controlCenter.designGate.requiredFields") });
      return;
    }
    await runMutation(() => createDesignGateDeclaration({
      projectWorkspacePath: selectedSession.projectWorkspacePath,
      hostSessionId: selectedSession.hostSessionId,
      specPath: specPath.trim(),
      scope: { paths, actions: scopeActions },
      decision: newDecision,
    }));
  }, [newDecision, runMutation, scopeActions, scopePaths, selectedSession, specPath, t]);

  const mutateDecision = useCallback((decision: DesignGateDecision) => {
    if (!declaration) return;
    void runMutation(() => updateDesignGateDecision(declaration.sourceRef, declaration.revision, decision));
  }, [declaration, runMutation]);

  const revoke = useCallback(() => {
    if (!declaration) return;
    void runMutation(() => revokeDesignGateDeclaration(declaration.sourceRef, declaration.revision));
  }, [declaration, runMutation]);

  const disabled = pending || declarationLoading || sessionsLoading;

  return (
    <section className="mt-8" aria-labelledby="section-design-gate">
      <SectionTitle id="section-design-gate">{t("pages.controlCenter.designGate.title")}</SectionTitle>
      <p className="mb-4 max-w-[68ch] text-[13px] leading-relaxed text-ink-3">
        {t("pages.controlCenter.designGate.description")}
      </p>

      {error && (
        <div role="alert" className="mb-4 rounded-[4px] border border-amber/30 border-l-2 border-l-amber bg-amber/10 p-3 text-[12.5px] text-ink-2">
          <p>{error.error}</p>
          {error.nextAction && <p className="mt-1 text-ink-3">{error.nextAction}</p>}
          {error.status === 409 && selectedSession && (
            <button type="button" className="mt-2 underline" disabled={disabled} onClick={() => void loadDeclaration(selectedSession)}>
              {t("pages.controlCenter.designGate.refresh")}
            </button>
          )}
        </div>
      )}

      {sessionsLoading ? (
        <p className="text-[13px] text-ink-3">{t("pages.controlCenter.designGate.loadingSessions")}</p>
      ) : sessions.length === 0 ? (
        <div className="rounded-[4px] border border-line bg-panel p-4 text-[13px] text-ink-3">
          <p>{t("pages.controlCenter.designGate.noSessions")}</p>
          <button type="button" className={`${actionButtonClass()} mt-3`} disabled={disabled} onClick={() => void loadSessions()}>
            {t("pages.controlCenter.designGate.refresh")}
          </button>
        </div>
      ) : (
        <div className="space-y-4 rounded-[4px] border border-line bg-panel p-4">
          <label className="block text-[12.5px] font-medium text-ink">
            {t("pages.controlCenter.designGate.nativeSession")}
            <select className={fieldClass()} value={selectedKey} disabled={disabled} onChange={(event) => setSelectedKey(event.currentTarget.value)}>
              {sessions.map((session) => (
                <option key={sessionKey(session)} value={sessionKey(session)}>
                  {session.projectWorkspacePath} · {session.hostSessionId}
                </option>
              ))}
            </select>
          </label>

          {declarationLoading ? (
            <p className="text-[13px] text-ink-3">{t("pages.controlCenter.designGate.loadingDeclaration")}</p>
          ) : declaration && !declaration.revoked ? (
            <div className="space-y-3" aria-live="polite">
              <div className="grid gap-2 rounded-[4px] border border-line-2 bg-surface p-3 text-[12.5px]">
                <p><strong>{t("pages.controlCenter.designGate.decision")}</strong> {t(`pages.controlCenter.designGate.decisions.${decisionTranslationKey[declaration.decision]}`)}{declaration.revoked ? ` · ${t("pages.controlCenter.designGate.revoked")}` : ""}</p>
                <p><strong>{t("pages.controlCenter.designGate.revision")}</strong> {declaration.revision}</p>
                <p><strong>{t("pages.controlCenter.designGate.spec")}</strong> <span className="break-all font-mono">{declaration.specPath}</span></p>
                <p><strong>{t("pages.controlCenter.designGate.specDigest")}</strong> <span className="break-all font-mono">{declaration.specDigest}</span></p>
                <p><strong>{t("pages.controlCenter.designGate.scopePaths")}</strong> <span className="font-mono">{declaration.scope.paths.join(", ")}</span></p>
                <p><strong>{t("pages.controlCenter.designGate.scopeActions")}</strong> {declaration.scope.actions.map((action) => t(`pages.controlCenter.designGate.actions.${actionTranslationKey[action]}`)).join(", ")}</p>
                <p><strong>{t("pages.controlCenter.designGate.owner")}</strong> <span className="font-mono">{declaration.actor.ownerId}</span></p>
                <p><strong>{t("pages.controlCenter.designGate.decidedAt")}</strong> {declaration.decidedAt}</p>
              </div>
              <p className="border-l-2 border-amber pl-3 text-[12.5px] leading-relaxed text-ink-3">
                {t("pages.controlCenter.designGate.semanticLimit")}
              </p>
              {!declaration.revoked && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={actionButtonClass()} disabled={disabled || declaration.decision === "approved"} onClick={() => mutateDecision("approved")}>
                    {pending ? t("pages.controlCenter.designGate.saving") : t("pages.controlCenter.designGate.approve")}
                  </button>
                  <button type="button" className={actionButtonClass()} disabled={disabled || declaration.decision === "not_approved"} onClick={() => mutateDecision("not_approved")}>
                    {t("pages.controlCenter.designGate.markPending")}
                  </button>
                  <button type="button" className={actionButtonClass()} disabled={disabled} onClick={revoke}>
                    {t("pages.controlCenter.designGate.revoke")}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3 border-t border-line pt-4">
              {declaration?.revoked && (
                <div className="rounded-[4px] border border-line-2 bg-surface p-3 text-[12.5px] text-ink-3">
                  <p>{t("pages.controlCenter.designGate.revokedLatest", { revision: declaration.revision })}</p>
                  <p className="mt-1 break-all font-mono">{declaration.specPath} · {declaration.scope.paths.join(", ")}</p>
                </div>
              )}
              <p className="text-[12.5px] text-ink-3">{t("pages.controlCenter.designGate.noDeclaration")}</p>
              <label className="block text-[12.5px] font-medium text-ink">
                {t("pages.controlCenter.designGate.specPath")}
                <input className={fieldClass()} value={specPath} onChange={(event) => setSpecPath(event.currentTarget.value)} placeholder={t("pages.controlCenter.designGate.specPathHint")} disabled={disabled} />
              </label>
              <label className="block text-[12.5px] font-medium text-ink">
                {t("pages.controlCenter.designGate.scopePathsInput")}
                <textarea className={fieldClass()} rows={3} value={scopePaths} onChange={(event) => setScopePaths(event.currentTarget.value)} placeholder={t("pages.controlCenter.designGate.scopePathsHint")} disabled={disabled} />
              </label>
              <p className="-mt-2 text-[12px] leading-relaxed text-ink-4">{t("pages.controlCenter.designGate.scopePathsHelp")}</p>
              <fieldset disabled={disabled}>
                <legend className="text-[12.5px] font-medium text-ink">{t("pages.controlCenter.designGate.scopeActionsInput")}</legend>
                <div className="mt-2 flex flex-wrap gap-4">
                  {(["read", "write", "execute"] as const).map((action) => (
                    <label key={action} className="flex items-center gap-2 text-[12.5px] text-ink-2">
                      <input type="checkbox" checked={scopeActions.includes(action)} onChange={(event) => setScopeActions((current) => event.currentTarget.checked ? [...current, action] : current.filter((entry) => entry !== action))} />
                      {t(`pages.controlCenter.designGate.actions.${actionTranslationKey[action]}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="block text-[12.5px] font-medium text-ink">
                {t("pages.controlCenter.designGate.initialDecision")}
                <select className={fieldClass()} value={newDecision} onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (value === "approved" || value === "not_approved" || value === "not_required") setNewDecision(value);
                }} disabled={disabled}>
                  {(["not_approved", "approved", "not_required"] as const).map((decision) => (
                    <option key={decision} value={decision}>{t(`pages.controlCenter.designGate.decisions.${decisionTranslationKey[decision]}`)}</option>
                  ))}
                </select>
              </label>
              <p className="text-[12px] leading-relaxed text-ink-4">{t("pages.controlCenter.designGate.semanticLimit")}</p>
              <button type="button" className={actionButtonClass()} disabled={disabled} onClick={() => void createDeclaration()}>
                {pending ? t("pages.controlCenter.designGate.saving") : t("pages.controlCenter.designGate.create")}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
