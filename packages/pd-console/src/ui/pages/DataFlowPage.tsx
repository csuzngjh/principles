import { useState, useEffect } from 'react';
import { PageHeader } from '../components/page-header.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Skeleton } from '../components/ui/skeleton.js';
import { AlertTriangle, ArrowRight, Activity, CheckCircle, Clock, XCircle } from 'lucide-react';
import { fetchPipelineStats } from '../api.js';
import type { PipelineStats, PipelineStage, Bottleneck } from '../api.js';

function StageCard({ stage, index }: { stage: PipelineStage; index: number }) {
  const getStatusIcon = () => {
    switch (stage.status) {
      case 'normal': return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'slow': return <Clock className="w-5 h-5 text-yellow-500" />;
      case 'stuck': return <XCircle className="w-5 h-5 text-red-500" />;
    }
  };

  const getStatusVariant = (): 'default' | 'secondary' | 'destructive' => {
    switch (stage.status) {
      case 'normal': return 'default';
      case 'slow': return 'secondary';
      case 'stuck': return 'destructive';
    }
  };

  const getStatusLabel = () => {
    switch (stage.status) {
      case 'normal': return '正常';
      case 'slow': return '缓慢';
      case 'stuck': return '卡住';
    }
  };

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
      <Card className={`border-l-4 ${
        stage.status === 'normal' ? 'border-l-green-500' :
        stage.status === 'slow' ? 'border-l-yellow-500' :
        'border-l-red-500'
      }`}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                stage.status === 'normal' ? 'bg-green-100 text-green-700' :
                stage.status === 'slow' ? 'bg-yellow-100 text-yellow-700' :
                'bg-red-100 text-red-700'
              }`}>
                {index + 1}
              </div>
              <CardTitle className="text-base">{stage.name}</CardTitle>
            </div>
            {getStatusIcon()}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-muted-foreground">今日处理</p>
              <p className="text-xl font-bold">{stage.count}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">平均间隔</p>
              <p className="text-xl font-bold">{formatDuration(stage.avgDuration)}</p>
            </div>
          </div>
          
          <div className="flex items-center justify-between">
            <Badge variant={getStatusVariant()}>{getStatusLabel()}</Badge>
            <span className="text-xs text-muted-foreground">
              {formatTimeAgo(stage.lastProcessed)}
            </span>
          </div>

          {stage.gapMinutes !== null && stage.gapMinutes > 5 && (
            <div className="text-xs text-muted-foreground">
              距上次处理: {Math.floor(stage.gapMinutes)} 分钟
            </div>
          )}
        </CardContent>
      </Card>

      {index < 3 && (
        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 z-10">
          <ArrowRight className="w-5 h-5 text-muted-foreground rotate-90" />
        </div>
      )}
    </div>
  );
}

function BottleneckAlert({ bottleneck }: { bottleneck: Bottleneck }) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg ${
      bottleneck.severity === 'critical' ? 'bg-red-50 border border-red-200' :
      'bg-yellow-50 border border-yellow-200'
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
      <div className="space-y-6">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="relative">
            <Skeleton className="h-48 w-full" />
            {i < 4 && <div className="absolute -bottom-6 left-1/2 -translate-x-1/2"><Skeleton className="h-5 w-5" /></div>}
          </div>
        ))}
      </div>
    </div>
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="数据流"
        description="Pain Chain 管道状态监控"
        onRefresh={fetchData}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Activity className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">今日处理</p>
                <p className="text-2xl font-bold">{data.totalProcessed}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <CheckCircle className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">正常运行</p>
                <p className="text-2xl font-bold">
                  {data.stages.filter(s => s.status === 'normal').length}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${
                data.bottlenecks.some(b => b.severity === 'critical') 
                  ? 'bg-red-100' 
                  : data.bottlenecks.length > 0 
                  ? 'bg-yellow-100' 
                  : 'bg-green-100'
              }`}>
                <AlertTriangle className={`w-5 h-5 ${
                  data.bottlenecks.some(b => b.severity === 'critical') 
                    ? 'text-red-600' 
                    : data.bottlenecks.length > 0 
                    ? 'text-yellow-600' 
                    : 'text-green-600'
                }`} />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">瓶颈检测</p>
                <p className="text-2xl font-bold">{data.bottlenecks.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
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

      <div className="space-y-8">
        {data.stages.map((stage, index) => (
          <StageCard key={stage.id} stage={stage} index={index} />
        ))}
      </div>

      <Card className="bg-muted/50">
        <CardContent className="p-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>数据刷新间隔: 15 秒</span>
            <span>最后更新: {new Date(data.generatedAt).toLocaleTimeString()}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
