import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getToken, setToken, fetchWorkspaces, addWorkspace, removeWorkspace, syncWorkspace } from "../api.js";
import type { WorkspaceEntry } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { Separator } from "../components/ui/separator.js";
import { Key, Plus, RefreshCw, Trash2, CheckCircle, XCircle } from "lucide-react";

function AuthSettings() {
  const { t } = useTranslation();
  const [tokenValue, setTokenValue] = useState(() => getToken() ?? "");
  const [saved, setSaved] = useState(false);

  function handleSave() {
    const trimmed = tokenValue.trim();
    if (!trimmed) return;
    setToken(trimmed);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Key className="h-4 w-4" />
          {t("pages:settings.auth")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <label className="block mb-2 text-sm font-medium">
          Bearer Token
          <input
            type="password"
            value={tokenValue}
            onChange={(e) => { setTokenValue(e.target.value); setSaved(false); }}
            placeholder="Enter access token"
            className="mt-1 w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <Button onClick={handleSave} disabled={!tokenValue.trim()}>
          {t("common:save")}
        </Button>
        {saved && (
          <div className="mt-3 flex items-center gap-2 text-sm text-primary">
            <CheckCircle className="h-4 w-4" />
            {t("pages:settings.tokenSaved")}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Token is stored in the browser session and will be cleared when the tab is closed.
        </p>
      </CardContent>
    </Card>
  );
}

function WorkspaceManager() {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetchWorkspaces().then((r) => {
      if (r.success) setWorkspaces(r.data);
    });
  }, []);

  function showMessage(type: "success" | "error", text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  }

  async function handleAdd() {
    if (!newName.trim() || !newPath.trim()) return;
    const result = await addWorkspace(newName.trim(), newPath.trim());
    if (result.success) {
      setWorkspaces((prev) => [...prev, result.data]);
      setNewName("");
      setNewPath("");
      showMessage("success", t("pages:settings.workspaceAdded"));
    } else {
      showMessage("error", result.error);
    }
  }

  async function handleRemove(name: string) {
    const result = await removeWorkspace(name);
    if (result.success) {
      setWorkspaces((prev) => prev.filter(w => w.name !== name));
      showMessage("success", t("pages:settings.workspaceRemoved"));
    } else {
      showMessage("error", result.error);
    }
  }

  async function handleSync(name: string) {
    const result = await syncWorkspace(name);
    if (result.success) {
      showMessage("success", `Workspace "${name}" synced`);
      const refreshResult = await fetchWorkspaces();
      if (refreshResult.success) setWorkspaces(refreshResult.data);
    } else {
      showMessage("error", result.error);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pages:settings.workspace")}</CardTitle>
      </CardHeader>
      <CardContent>
        {workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No workspaces configured
          </p>
        ) : (
          <div className="space-y-3">
            {workspaces.map((ws) => (
              <div
                key={ws.name}
                className="flex justify-between items-center py-3 border-b border-border last:border-0"
              >
                <div>
                  <p className="font-medium text-sm">
                    {ws.config?.displayName ?? ws.name}
                  </p>
                  <p className="text-xs text-muted-foreground">{ws.path}</p>
                  {ws.lastSync && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Last sync: {new Date(ws.lastSync).toLocaleString()}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => handleSync(ws.name)}>
                    <RefreshCw className="h-3 w-3 mr-1" />
                    {t("pages:settings.syncWorkspace")}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => handleRemove(ws.name)}>
                    <Trash2 className="h-3 w-3 mr-1" />
                    {t("pages:settings.removeWorkspace")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <Separator className="my-4" />

        <h4 className="text-sm font-medium mb-3">{t("pages:settings.addWorkspace")}</h4>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground">{t("common:name")}</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="my-workspace"
              className="mt-1 w-full px-3 py-1.5 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex-[2]">
            <label className="text-xs text-muted-foreground">Path</label>
            <input
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="/path/to/workspace"
              className="mt-1 w-full px-3 py-1.5 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <Button
            onClick={handleAdd}
            disabled={!newName.trim() || !newPath.trim()}
            size="sm"
          >
            <Plus className="h-3 w-3 mr-1" />
            {t("common:add")}
          </Button>
        </div>

        {message && (
          <div
            className={`mt-3 flex items-center gap-2 text-sm p-2 rounded-md ${
              message.type === "success"
                ? "bg-primary/10 text-primary"
                : "bg-destructive/10 text-destructive"
            }`}
          >
            {message.type === "success" ? (
              <CheckCircle className="h-4 w-4" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            {message.text}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();

  return (
    <div className="max-w-2xl">
      <PageHeader
        title={t("pages:settings.title")}
        description={t("pages:settings.description")}
      />
      <AuthSettings />
      <WorkspaceManager />
    </div>
  );
}
