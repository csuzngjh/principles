import { useState } from "react";
import { useTranslation } from "react-i18next";
import { setToken, clearToken, checkAuth } from "../api.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { Dna, Eye, EyeOff } from "lucide-react";

interface LoginPageProps {
  onAuthSuccess: () => void;
}

export function LoginPage({ onAuthSuccess }: LoginPageProps) {
  const { t } = useTranslation();
  const [token, setTokenValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [showToken, setShowToken] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError(t("pages:login.errorEmpty"));
      return;
    }

    setChecking(true);
    setError(null);

    setToken(trimmed);
    const isValid = await checkAuth();
    setChecking(false);

    if (isValid) {
      onAuthSuccess();
    } else {
      clearToken();
      setError(t("pages:login.errorInvalid"));
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-2">
          <div className="flex justify-center mb-4">
            <div className="p-3 rounded-full bg-primary/10">
              <Dna className="h-8 w-8 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl">PD Console</CardTitle>
          <p className="text-sm text-primary font-medium tracking-wider mt-1">{t("pages:login.slogan")}</p>
          <CardDescription className="mt-2">
            {t("pages:login.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <label className="block text-sm font-medium mb-1.5">
              Bearer Token
            </label>
            <div className="relative">
              <input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => {
                  setTokenValue(e.target.value);
                  setError(null);
                }}
                placeholder="Enter access token"
                autoFocus
                className={`w-full px-3 py-2.5 rounded-md border text-sm focus:outline-none focus:ring-2 focus:ring-ring pr-10 ${
                  error ? "border-destructive" : "border-input"
                }`}
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>

            {error && (
              <p className="mt-2 text-sm text-destructive">{error}</p>
            )}

            <Button
              type="submit"
              disabled={checking || !token.trim()}
              className="w-full mt-5"
            >
              {checking ? "Verifying..." : t("pages:login.signIn")}
            </Button>
          </form>

          <div className="mt-6 pt-4 border-t border-border text-xs text-muted-foreground text-center">
            Token is stored in browser session only.
            <br />
            Use <code className="bg-muted px-1 py-0.5 rounded text-xs">--no-auth</code> flag to disable authentication.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
