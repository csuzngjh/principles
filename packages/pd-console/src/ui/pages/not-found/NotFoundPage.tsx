import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { StatePanel } from "../../components/ui/state-panel.js";

/**
 * Unknown route. Before B1 the authenticated catch-all rendered nothing, so a
 * mistyped or stale hash link produced a blank page with no way back.
 */
export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <PageShell>
      <div className="mt-10">
        <StatePanel
          kind="empty"
          title={t("common.notFoundTitle")}
          body={t("common.notFoundBody")}
          action={{ label: t("common.notFoundAction"), to: "/focus" }}
          testId="not-found-state"
        />
      </div>
    </PageShell>
  );
}
