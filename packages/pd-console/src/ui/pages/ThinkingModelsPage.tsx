import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { fetchThinkingModels } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Brain, ChevronRight } from "lucide-react";

interface ThinkingOsDirective {
  id: string;
  name: string;
  trigger: string;
  must: string;
  forbidden: string;
}

interface ThinkingModelOverview {
  totalModels: number;
  models: ThinkingOsDirective[];
  source: string;
}

export function ThinkingModelsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<ThinkingModelOverview | null>(null);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    fetchThinkingModels().then((result) => {
      if (result.success) {
        setData(result.data);
        setError("");
      } else {
        setError(result.error);
      }
    });
  }, []);

  if (error && !data) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <div>
        <Skeleton className="h-8 w-48 mb-6" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="mb-3">
            <CardContent className="p-4">
              <Skeleton className="h-5 w-40 mb-2" />
              <Skeleton className="h-3 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("pages:thinking-models.title")}
        description={t("pages:thinking-models.description")}
        actions={
          <span className="text-sm text-muted-foreground">
            {data.totalModels} models | Source: {data.source}
          </span>
        }
      />

      {data.totalModels === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Brain className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm mb-1">{t("pages:thinking-models.noModels")}</p>
            <p className="text-xs">
              Place a THINKING_OS.md file in the workspace root or .state directory
            </p>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {data.models.map((model) => (
          <Card key={model.id} className="overflow-hidden">
            <div
              onClick={() => setExpandedId(expandedId === model.id ? null : model.id)}
              className={`p-4 cursor-pointer flex justify-between items-center transition-colors duration-150 ${
                expandedId === model.id ? "bg-primary/5" : "hover:bg-accent"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-primary">{model.id}</span>
                <span className="text-sm">{model.name}</span>
              </div>
              <ChevronRight
                className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${
                  expandedId === model.id ? "rotate-90" : ""
                }`}
              />
            </div>

            <div
              className={`overflow-hidden transition-all duration-300 ${
                expandedId === model.id ? "max-h-[600px] opacity-100" : "max-h-0 opacity-0"
              }`}
            >
              <div className="p-4 border-t border-border space-y-4">
                {model.trigger && (
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-1">
                      {t("pages:thinking-models.trigger")}
                    </h4>
                    <div className="bg-muted/50 p-3 rounded-md text-sm leading-relaxed whitespace-pre-wrap">
                      {model.trigger}
                    </div>
                  </div>
                )}

                {model.must && (
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-1">
                      {t("pages:thinking-models.must")}
                    </h4>
                    <div className="bg-primary/5 p-3 rounded-md text-sm leading-relaxed whitespace-pre-wrap border-l-3 border-l-primary">
                      {model.must}
                    </div>
                  </div>
                )}

                {model.forbidden && (
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground mb-1">
                      {t("pages:thinking-models.forbidden")}
                    </h4>
                    <div className="bg-destructive/5 p-3 rounded-md text-sm leading-relaxed whitespace-pre-wrap border-l-3 border-l-destructive">
                      {model.forbidden}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
