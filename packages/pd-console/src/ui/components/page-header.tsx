import * as React from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Button } from "./ui/button.js";
import { Separator } from "./ui/separator.js";

interface PageHeaderProps {
  title: string;
  description?: string;
  onRefresh?: () => void;
  lastUpdated?: Date | null;
  actions?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  onRefresh,
  lastUpdated,
  actions,
}: PageHeaderProps) {
  const [refreshing, setRefreshing] = React.useState(false);

  const handleRefresh = async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const formatTime = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    return `${days}天前`;
  };

  return (
    <header className="mb-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw
                className={cn(
                  "h-4 w-4 mr-2",
                  refreshing && "animate-spin"
                )}
              />
              刷新
            </Button>
          )}
          {actions}
        </div>
      </div>
      {lastUpdated && (
        <div className="mt-3 flex items-center text-xs text-muted-foreground">
          <span>最后更新: {formatTime(lastUpdated)}</span>
        </div>
      )}
      <Separator className="mt-4" />
    </header>
  );
}
