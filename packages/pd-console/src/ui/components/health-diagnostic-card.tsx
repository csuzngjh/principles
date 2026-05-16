import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface HealthCheckItem {
  id: string;
  name: string;
  status: 'healthy' | 'warning' | 'error';
  message: string;
  lastCheck: string;
}

interface HealthDiagnosticCardProps {
  overall: 'healthy' | 'degraded' | 'error';
  checks: HealthCheckItem[];
  onRefresh?: () => void;
  loading?: boolean;
}

export function HealthDiagnosticCard({
  overall,
  checks,
  onRefresh,
  loading,
}: HealthDiagnosticCardProps) {
  const { t } = useTranslation();
  const healthyCount = checks.filter(c => c.status === 'healthy').length;
  const totalCount = checks.length;

  const getOverallStatusText = () => {
    switch (overall) {
      case 'healthy': return t('components:healthDiagnostic.allNormal');
      case 'degraded': return t('components:healthDiagnostic.needsAttention');
      case 'error': return t('components:healthDiagnostic.criticalIssues');
    }
  };

  const getOverallBadgeVariant = (): 'default' | 'secondary' | 'destructive' => {
    switch (overall) {
      case 'healthy': return 'default';
      case 'degraded': return 'secondary';
      case 'error': return 'destructive';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'healthy': return '\u2713';
      case 'warning': return '\u26A0';
      case 'error': return '\u2717';
      default: return '?';
    }
  };

  const getStatusBadgeVariant = (status: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (status) {
      case 'healthy': return 'default';
      case 'warning': return 'secondary';
      case 'error': return 'destructive';
      default: return 'outline';
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-center">
          <CardTitle className="text-sm">{t('components:healthDiagnostic.title')}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={getOverallBadgeVariant()}>
              {healthyCount}/{totalCount} healthy &middot; {getOverallStatusText()}
            </Badge>
            {onRefresh && (
              <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {checks.map((check) => (
          <div key={check.id} className="flex items-center justify-between py-1 border-b last:border-0">
            <div className="flex items-center gap-2">
              <Badge variant={getStatusBadgeVariant(check.status)}>
                {getStatusIcon(check.status)}
              </Badge>
              <span className="text-sm">{check.name}</span>
            </div>
            <span className="text-xs text-muted-foreground">{check.message}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
