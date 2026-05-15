import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Separator } from "../components/ui/separator.js";
import {
  Cpu,
  Stethoscope,
  Moon,
  Sparkles,
  Scale,
  PenTool,
  SearchCheck,
  ShieldCheck,
  X,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  AlertCircle,
  Clock,
} from "lucide-react";
import { fetchAgents, fetchAgentDetail } from "../api.js";
import type { AgentInfo, AgentDetail } from "../api.js";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Cpu,
  Stethoscope,
  Moon,
  Sparkles,
  Scale,
  PenTool,
  SearchCheck,
  ShieldCheck,
};

const STATUS_COLORS: Record<string, string> = {
  running: "#22c55e",
  idle: "#9ca3af",
  cooldown: "#eab308",
  failed: "#ef4444",
  unknown: "#d1d5db",
};

const STATUS_BADGE_VARIANT = {
  running: "default",
  idle: "secondary",
  cooldown: "outline",
  failed: "destructive",
  unknown: "secondary",
} as const satisfies Record<string, string>;

interface FlowNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  nameZh: string;
  icon: string;
  small?: boolean;
}

interface FlowEdge {
  from: string;
  to: string;
}

const FLOW_NODES: FlowNode[] = [
  { id: "after_tool_call", x: 60, y: 40, w: 150, h: 52, nameZh: "after_tool_call", icon: "ShieldCheck" },
  { id: "pain-diagnostic-gate", x: 280, y: 40, w: 170, h: 52, nameZh: "PainDiagnosticGate", icon: "SearchCheck" },
  { id: "diagnostician", x: 520, y: 40, w: 150, h: 52, nameZh: "诊断者", icon: "Stethoscope" },
  { id: "evolution-worker", x: 60, y: 180, w: 170, h: 52, nameZh: "Evolution Worker", icon: "Cpu" },
  { id: "nocturnal-reflection", x: 310, y: 180, w: 170, h: 52, nameZh: "夜间反思", icon: "Moon" },
  { id: "trinity-dreamer", x: 560, y: 140, w: 130, h: 44, nameZh: "Dreamer", icon: "Sparkles", small: true },
  { id: "trinity-philosopher", x: 560, y: 192, w: 130, h: 44, nameZh: "Philosopher", icon: "Scale", small: true },
  { id: "trinity-scribe", x: 560, y: 244, w: 130, h: 44, nameZh: "Scribe", icon: "PenTool", small: true },
  { id: "correction-observer", x: 310, y: 320, w: 170, h: 52, nameZh: "纠正观察者", icon: "SearchCheck" },
  { id: "detection-funnel", x: 60, y: 320, w: 150, h: 44, nameZh: "Detection Funnel", icon: "Cpu", small: true },
];

const FLOW_EDGES: FlowEdge[] = [
  { from: "after_tool_call", to: "pain-diagnostic-gate" },
  { from: "pain-diagnostic-gate", to: "diagnostician" },
  { from: "evolution-worker", to: "nocturnal-reflection" },
  { from: "nocturnal-reflection", to: "trinity-dreamer" },
  { from: "nocturnal-reflection", to: "trinity-philosopher" },
  { from: "nocturnal-reflection", to: "trinity-scribe" },
  { from: "evolution-worker", to: "correction-observer" },
  { from: "evolution-worker", to: "detection-funnel" },
];

const SVG_W = 760;
const SVG_H = 400;

function getNodeCenter(node: FlowNode) {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

function getEdgePath(from: FlowNode, to: FlowNode) {
  const fc = getNodeCenter(from);
  const tc = getNodeCenter(to);
  const startX = from.x + from.w;
  const startY = fc.y;
  const endX = to.x;
  const endY = tc.y;
  const midX = (startX + endX) / 2;
  return `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;
}

function AgentNode({
  node,
  agent,
  selected,
  onClick,
}: {
  node: FlowNode;
  agent: AgentInfo | undefined;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = ICON_MAP[node.icon] ?? Cpu;
  const status = agent?.status ?? "unknown";

  return (
    <g onClick={onClick} style={{ cursor: "pointer" }}>
      <rect
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={node.small ? 6 : 10}
        fill="var(--color-card, hsl(0 0% 100%))"
        stroke={selected ? "var(--color-primary, hsl(220 90% 56%))" : "var(--color-border, hsl(220 14% 78%))"}
        strokeWidth={selected ? 2.5 : 1.5}
        className="transition-all duration-200"
      />
      <foreignObject
        x={node.x + 6}
        y={node.y + (node.small ? 4 : 6)}
        width={node.small ? 16 : 22}
        height={node.small ? 16 : 22}
      >
        <div className={node.small ? "w-3.5 h-3.5 text-muted-foreground" : "w-4.5 h-4.5 text-muted-foreground"}>
          <Icon className="w-full h-full" />
        </div>
      </foreignObject>
      <text
        x={node.x + 34}
        y={node.y + node.h / 2 + 1}
        dominantBaseline="middle"
        fontSize={node.small ? 11 : 13}
        fontWeight={500}
        fill="var(--color-foreground, hsl(0 0% 9%))"
      >
        {node.nameZh}
      </text>
      <circle
        cx={node.x + node.w - 14}
        cy={node.y + node.h / 2}
        r={5}
        fill={STATUS_COLORS[status]}
        className="transition-colors duration-300"
      />
      {agent?.cooldownRemaining && (
        <text
          x={node.x + node.w - 14}
          y={node.y + 6}
          textAnchor="middle"
          fontSize={8}
          fill="hsl(45 93% 47%)"
        >
          ⏳
        </text>
      )}
    </g>
  );
}

function TrinityGroup() {
  const dreamer = FLOW_NODES.find((n) => n.id === "trinity-dreamer")!;
  const scribe = FLOW_NODES.find((n) => n.id === "trinity-scribe")!;
  const pad = 12;
  return (
    <rect
      x={dreamer.x - pad}
      y={dreamer.y - pad}
      width={dreamer.w + pad * 2}
      height={scribe.y + scribe.h - dreamer.y + pad * 2}
      rx={8}
      fill="none"
      stroke="var(--color-border, hsl(220 14% 78%))"
      strokeWidth={1}
      strokeDasharray="6 3"
    />
  );
}

function FlowEdgeLine({ from, to }: { from: FlowNode; to: FlowNode }) {
  const d = getEdgePath(from, to);
  return (
    <g>
      <defs>
        <marker
          id={`arrow-${from.id}-${to.id}`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-accent, hsl(180 70% 50%))" />
        </marker>
      </defs>
      <path
        d={d}
        fill="none"
        stroke="var(--color-accent, hsl(180 70% 50%))"
        strokeWidth={1.8}
        markerEnd={`url(#arrow-${from.id}-${to.id})`}
        className="opacity-70"
      />
    </g>
  );
}

function RowLabel({ x, y, text }: { x: number; y: number; text: string }) {
  return (
    <text x={x} y={y} fontSize={10} fill="var(--color-muted-foreground, hsl(220 10% 46%))" fontStyle="italic">
      {text}
    </text>
  );
}

function AgentFlowMap({
  agents,
  selectedId,
  onSelect,
}: {
  agents: AgentInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  return (
    <Card>
      <CardContent className="p-4">
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className="w-full h-auto"
          style={{ maxHeight: 500 }}
        >
          <RowLabel x={60} y={24} text="实时触发路径" />
          <RowLabel x={60} y={168} text="后台心跳路径 (Evolution Worker 驱动)" />

          {FLOW_EDGES.map((edge) => {
            const fromNode = FLOW_NODES.find((n) => n.id === edge.from)!;
            const toNode = FLOW_NODES.find((n) => n.id === edge.to)!;
            return <FlowEdgeLine key={`${edge.from}-${edge.to}`} from={fromNode} to={toNode} />;
          })}

          <TrinityGroup />

          {FLOW_NODES.map((node) => (
            <AgentNode
              key={node.id}
              node={node}
              agent={agentMap.get(node.id)}
              selected={selectedId === node.id}
              onClick={() => onSelect(node.id)}
            />
          ))}
        </svg>
      </CardContent>
    </Card>
  );
}

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-medium w-full py-1"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {title}
      </button>
      {open && <div className="pl-5 pb-2">{children}</div>}
    </div>
  );
}

function AgentDrawer({
  agent,
  loading,
  onClose,
}: {
  agent: AgentDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  if (!agent && !loading) return null;

  const Icon = ICON_MAP[agent?.icon ?? ""] ?? Cpu;

  return (
    <div className="fixed right-0 top-0 h-screen w-[400px] bg-background border-l border-border shadow-xl z-50 flex flex-col transition-transform duration-300">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary" />
          <span className="font-semibold text-lg">{agent?.nameZh ?? agent?.name ?? ""}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : agent ? (
          <>
            <div className="flex items-center gap-2">
              <Badge variant={STATUS_BADGE_VARIANT[agent.status] ?? "secondary"}>
                {t(`pages:agents.${agent.status}`)}
              </Badge>
              {agent.lastRunAt && (
                <span className="text-xs text-muted-foreground">
                  <Clock className="h-3 w-3 inline mr-1" />
                  {new Date(agent.lastRunAt).toLocaleString()}
                </span>
              )}
            </div>

            <p className="text-sm text-muted-foreground">
              {agent.descriptionZh || agent.description}
            </p>

            {agent.cooldownRemaining && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-yellow-50 border border-yellow-200">
                <Clock className="h-4 w-4 text-yellow-600" />
                <span className="text-sm text-yellow-700">
                  {t("pages:agents.cooldown")}: {agent.cooldownRemaining}
                </span>
              </div>
            )}

            <Separator />

            <CollapsibleSection title={t("pages:agents.prompt")} defaultOpen={false}>
              <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto">
                {agent.prompt || "—"}
              </pre>
            </CollapsibleSection>

            <CollapsibleSection title={t("pages:agents.tools")} defaultOpen={true}>
              <div className="flex flex-wrap gap-1.5">
                {agent.tools.length > 0 ? (
                  agent.tools.map((tool) => (
                    <Badge key={tool} variant="outline" className="text-xs">
                      {tool}
                    </Badge>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </div>
            </CollapsibleSection>

            <Separator />

            <div>
              <h4 className="text-sm font-medium mb-2">{t("pages:agents.recentRuns")}</h4>
              {agent.recentTasks.length > 0 ? (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b">
                      <th className="text-left py-1 font-medium">Time</th>
                      <th className="text-left py-1 font-medium">Status</th>
                      <th className="text-left py-1 font-medium">Attempts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agent.recentTasks.slice(0, 5).map((task) => (
                      <tr key={task.taskId} className="border-b border-border/50">
                        <td className="py-1.5">
                          {new Date(task.createdAt).toLocaleTimeString()}
                        </td>
                        <td className="py-1.5">
                          <Badge
                            variant={
                              task.status === "succeeded"
                                ? "default"
                                : task.status === "failed"
                                  ? "destructive"
                                  : "secondary"
                            }
                            className="text-[10px]"
                          >
                            {task.status}
                          </Badge>
                        </td>
                        <td className="py-1.5">{task.attemptCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("pages:agents.noRecentRuns")}
                </p>
              )}
            </div>

            {agent.recentTasks.some((t) => t.lastError) && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-2 text-destructive">
                    {t("pages:agents.errorLog")}
                  </h4>
                  <div className="space-y-2">
                    {agent.recentTasks
                      .filter((t) => t.lastError)
                      .map((task) => (
                        <div
                          key={task.taskId}
                          className="p-2 rounded-md bg-red-50 border border-red-200 text-xs"
                        >
                          <p className="font-medium text-red-700">{task.lastError}</p>
                          <p className="text-red-500 mt-1">
                            {new Date(task.updatedAt).toLocaleString()}
                          </p>
                        </div>
                      ))}
                  </div>
                </div>
              </>
            )}

            <Separator />

            <Button variant="outline" size="sm" className="w-full" asChild>
              <a href="#/tasks">
                <ExternalLink className="h-3 w-3 mr-2" />
                {t("pages:agents.viewTasks")}
              </a>
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-20" />
      </div>
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-[400px] w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function AgentsPageInner() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadData = useCallback(async () => {
    const result = await fetchAgents();
    if (!result.success) {
      setError(result.error ?? "加载失败");
    } else {
      setAgents(result.data);
      setLastUpdated(new Date());
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30_000);
    return () => clearInterval(interval);
  }, [loadData]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetchAgentDetail(selectedId).then((result) => {
      if (cancelled) return;
      setDetailLoading(false);
      if (result.success && result.data) {
        setDetail(result.data);
      } else {
        setDetail(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const handleSelect = (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  };

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <p className="text-destructive">{error}</p>
          </div>
          <Button variant="outline" className="mt-4" onClick={loadData}>
            {t("common:refresh")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="relative">
      <PageHeader
        title={t("pages:agents.title")}
        description={t("pages:agents.description")}
        onRefresh={loadData}
        lastUpdated={lastUpdated ?? undefined}
      />

      <AgentFlowMap agents={agents} selectedId={selectedId} onSelect={handleSelect} />

      {(selectedId || detailLoading) && (
        <AgentDrawer
          agent={detail}
          loading={detailLoading}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

export function AgentsPage() {
  return <AgentsPageInner />;
}
