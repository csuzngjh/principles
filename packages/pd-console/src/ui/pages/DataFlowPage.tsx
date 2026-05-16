import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/page-header.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Badge } from '../components/ui/badge.js';
import { formatTime } from '../utils/format.js';
import { Button } from '../components/ui/button.js';
import { Skeleton } from '../components/ui/skeleton.js';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  Clock,
  XCircle,
  Zap,
  ListTodo,
  Sparkles,
  Shield,
  ChevronRight,
  TrendingUp,
  Activity,
} from 'lucide-react';
import { fetchPipelineStats } from '../api.js';
import type { PipelineStats, PipelineStage, Bottleneck } from '../api.js';

const STAGE_META: Record<string, { icon: typeof Zap; href: string; gradient: string; bgGlow: string; label: string }> = {
  pain_signal: {
    icon: Zap,
    href: '/event-log?type=pain_signal',
    gradient: 'from-amber-500 to-orange-500',
    bgGlow: 'bg-amber-500/10',
    label: 'Pain Signal',
  },
  task_created: {
    icon: ListTodo,
    href: '/tasks',
    gradient: 'from-blue-500 to-indigo-500',
    bgGlow: 'bg-blue-500/10',
    label: 'Task Created',
  },
  candidate_generated: {
    icon: Sparkles,
    href: '/evolution',
    gradient: 'from-purple-500 to-fuchsia-500',
    bgGlow: 'bg-purple-500/10',
    label: 'Candidate Generated',
  },
  principle_added: {
    icon: Shield,
    href: '/principles',
    gradient: 'from-emerald-500 to-teal-500',
    bgGlow: 'bg-emerald-500/10',
    label: 'Principle Added',
  },
};

const STATUS_CONFIG = {
  normal: {
    icon: CheckCircle,
    label: '正常',
    badge: 'default' as const,
    ring: 'ring-green-500/30',
    pulse: '',
  },
  slow: {
    icon: Clock,
    label: '缓慢',
    badge: 'secondary' as const,
    ring: 'ring-yellow-500/30',
    pulse: 'animate-pulse',
  },
  stuck: {
    icon: XCircle,
    label: '卡住',
    badge: 'destructive' as const,
    ring: 'ring-red-500/30',
    pulse: '',
  },
};

function StageCard({ stage, index }: { stage: PipelineStage; index: number }) {
  const navigate = useNavigate();
  const meta = STAGE_META[stage.id] ?? {
    icon: Activity,
    href: '#',
    gradient: 'from-gray-500 to-gray-600',
    bgGlow: 'bg-gray-500/10',
    label: stage.name,
  };
  const statusCfg = STATUS_CONFIG[stage.status] ?? STATUS_CONFIG.stuck;
  const StatusIcon = statusCfg.icon;
  const StageIcon = meta.icon;

  const formatDuration = (ms: number | null) => {
    if (ms === null) return '-';
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${Math.round(ms / 3600000)}h`;
  };

  const formatTimeAgo = (timestamp: string | null) => {
    if (!timestamp) return '从未';
    const now = new Date();
    const time = new Date(timestamp);
    const diffMs = now.getTime() - time.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour} 小时前`;
    return `${Math.floor(diffHour / 24)} 天前`;
  };

  return (
    <div className="relative">
      <Card
        className={`group cursor-pointer transition-all duration-300 hover:shadow-lg hover:scale-[1.01] ring-2 ${statusCfg.ring} overflow-hidden`}
        onClick={() => navigate(meta.href)}
      >
        <div className={`absolute inset-0 ${meta.bgGlow} opacity-40 group-hover:opacity-60 transition-opacity`} />
        <div className="relative">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${meta.gradient} flex items-center justify-center text-white shadow-md`}>
                  <StageIcon className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className="text-base group-hover:text-primary transition-colors">
                    {meta.label}
                  </CardTitle>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <StatusIcon className={`w-3.5 h-3.5 ${statusCfg.badge === 'destructive' ? 'text-red-500' : statusCfg.badge === 'secondary' ? 'text-yellow-500' : 'text-green-500'}`} />
                    <Badge variant={statusCfg.badge} className="text-[10px] px-1.5 py-0">
                      {statusCfg.label}
                    </Badge>
                  </div>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">今日处理</p>
                <p className="text-2xl font-bold mt-0.5">{stage.count}</p>
              </div>
              <div className="text-center">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">平均间隔</p>
                <p className="text-2xl font-bold mt-0.5">{formatDuration(stage.avgDuration)}</p>
              </div>
              <div className="text-center">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">上次处理</p>
                <p className="text-sm font-semibold mt-1">{formatTimeAgo(stage.lastProcessed)}</p>
              </div>
            </div>

            {stage.gapMinutes !== null && stage.gapMinutes > 5 && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 rounded-md px-2 py-1">
                <Clock className="w-3 h-3" />
                距上次处理: {Math.floor(stage.gapMinutes)} 分钟
              </div>
            )}
          </CardContent>
        </div>
      </Card>

      {index < 3 && (
        <div className="flex items-center justify-center py-2">
          <div className="flex items-center gap-1">
            <div className="w-1 h-1 rounded-full bg-muted-foreground/40" />
            <div className="w-1 h-1 rounded-full bg-muted-foreground/60" />
            <ArrowRight className="w-4 h-4 text-muted-foreground/80" />
            <div className="w-1 h-1 rounded-full bg-muted-foreground/60" />
            <div className="w-1 h-1 rounded-full bg-muted-foreground/40" />
          </div>
        </div>
      )}
    </div>
  );
}

function BottleneckAlert({ bottleneck }: { bottleneck: Bottleneck }) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg ${
      bottleneck.severity === 'critical' ? 'bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800' :
      'bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-800'
    }`}>
      <AlertTriangle className={`w-5 h-5 ${
        bottleneck.severity === 'critical' ? 'text-red-500' : 'text-yellow-500'
      }`} />
      <div className="flex-1">
        <p className="text-sm font-medium">{bottleneck.description}</p>
        <p className="text-xs text-muted-foreground">
          {bottleneck.fromStage} → {bottleneck.toStage}
        </p>
      </div>
      <Badge variant={bottleneck.severity === 'critical' ? 'destructive' : 'secondary'}>
        {bottleneck.gapMinutes.toFixed(1)} 分钟延迟
      </Badge>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-24" />)}
      </div>
      <div className="space-y-2">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="relative">
            <Skeleton className="h-44 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryStatCard({ icon: Icon, label, value, colorClass }: {
  icon: typeof Activity;
  label: string;
  value: number;
  colorClass: string;
}) {
  return (
    <Card className="transition-all duration-200 hover:shadow-md">
      <CardContent className="p-5">
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${colorClass}`}>
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
            <p className="text-2xl font-bold">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function DataFlowPage() {
  const [data, setData] = useState<PipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPipelineStats();
      if (!result.success) {
        setError(result.error || 'Failed to fetch pipeline stats');
      } else if (result.data) {
        setData(result.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) {
    return (
      <div>
        <PageHeader
          title="数据流"
          description="Pain Chain 管道状态监控"
        />
        <LoadingSkeleton />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <PageHeader
          title="数据流"
          description="Pain Chain 管道状态监控"
          onRefresh={fetchData}
        />
        <Card>
          <CardContent className="p-6">
            <p className="text-destructive">加载失败: {error}</p>
            <Button onClick={fetchData} className="mt-4">
              重试
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const normalCount = data.stages.filter(s => s.status === 'normal').length;
  const hasCriticalBottleneck = data.bottlenecks.some(b => b.severity === 'critical');

  return (
    <div className="space-y-6">
      <PageHeader
        title="数据流"
        description="Pain Chain 管道状态监控"
        onRefresh={fetchData}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryStatCard
          icon={TrendingUp}
          label="今日处理"
          value={data.totalProcessed}
          colorClass="bg-primary/10 text-primary"
        />
        <SummaryStatCard
          icon={CheckCircle}
          label="正常运行"
          value={normalCount}
          colorClass="bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400"
        />
        <SummaryStatCard
          icon={AlertTriangle}
          label="瓶颈检测"
          value={data.bottlenecks.length}
          colorClass={
            hasCriticalBottleneck
              ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
              : data.bottlenecks.length > 0
                ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400'
                : 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
          }
        />
      </div>

      {data.bottlenecks.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-yellow-500" />
              检测到的瓶颈
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.bottlenecks.map((bottleneck, index) => (
              <BottleneckAlert key={index} bottleneck={bottleneck} />
            ))}
          </CardContent>
        </Card>
      )}

      <div className="space-y-1">
        {data.stages.map((stage, index) => (
          <StageCard key={stage.id} stage={stage} index={index} />
        ))}
      </div>

      <Card className="bg-muted/50">
        <CardContent className="p-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>数据刷新间隔: 15 秒</span>
            <span>最后更新: {formatTime(data.generatedAt)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
