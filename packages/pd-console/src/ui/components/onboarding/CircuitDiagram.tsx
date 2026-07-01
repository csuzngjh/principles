import { useTranslation } from 'react-i18next';

interface CircuitDiagramProps {
  /** Highlight a specific node (evidence/principle/ownerGate/behavior) */
  highlightNode?: 'evidence' | 'principle' | 'ownerGate' | 'behavior' | null;
  /** Compact mode for smaller spaces */
  compact?: boolean;
}

const NODES = [
  { id: 'evidence', labelKey: 'pages.welcome.step1.circuitNodes.evidence', cx: 80, cy: 80 },
  { id: 'principle', labelKey: 'pages.welcome.step1.circuitNodes.principle', cx: 240, cy: 80 },
  { id: 'ownerGate', labelKey: 'pages.welcome.step1.circuitNodes.ownerGate', cx: 240, cy: 180 },
  { id: 'behavior', labelKey: 'pages.welcome.step1.circuitNodes.behavior', cx: 80, cy: 180 },
] as const;

export function CircuitDiagram({ highlightNode = null, compact = false }: CircuitDiagramProps) {
  const { t } = useTranslation();
  const size = compact ? 240 : 320;
  const nodeRadius = compact ? 28 : 36;

  return (
    <div className="circuit-diagram" role="img" aria-label={t('pages.welcome.step1.circuitLabel')}>
      <svg
        width={size}
        height={size * 0.75}
        viewBox="0 0 320 240"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Connecting lines (thin, brand-aligned) */}
        <line x1={NODES[0].cx} y1={NODES[0].cy} x2={NODES[1].cx} y2={NODES[1].cy} stroke="var(--accent)" strokeWidth="1.5" />
        <line x1={NODES[1].cx} y1={NODES[1].cy} x2={NODES[2].cx} y2={NODES[2].cy} stroke="var(--accent)" strokeWidth="1.5" />
        <line x1={NODES[2].cx} y1={NODES[2].cy} x2={NODES[3].cx} y2={NODES[3].cy} stroke="var(--accent)" strokeWidth="1.5" />
        <line x1={NODES[3].cx} y1={NODES[3].cy} x2={NODES[0].cx} y2={NODES[0].cy} stroke="var(--accent)" strokeWidth="1.5" />

        {/* Arrow markers */}
        <polygon points={`${NODES[1].cx - 8},${NODES[1].cy - 4} ${NODES[1].cx - 8},${NODES[1].cy + 4} ${NODES[1].cx},${NODES[1].cy}`} fill="var(--accent)" />
        <polygon points={`${NODES[2].cx + 4},${NODES[2].cy - 8} ${NODES[2].cx - 4},${NODES[2].cy - 8} ${NODES[2].cx},${NODES[2].cy}`} fill="var(--accent)" />
        <polygon points={`${NODES[3].cx + 8},${NODES[3].cy - 4} ${NODES[3].cx + 8},${NODES[3].cy + 4} ${NODES[3].cx},${NODES[3].cy}`} fill="var(--accent)" />
        <polygon points={`${NODES[0].cx - 4},${NODES[0].cy + 8} ${NODES[0].cx + 4},${NODES[0].cy + 8} ${NODES[0].cx},${NODES[0].cy}`} fill="var(--accent)" />

        {/* Nodes */}
        {NODES.map((node) => {
          const isHighlighted = highlightNode === node.id;
          const isOwnerGate = node.id === 'ownerGate';
          return (
            <g key={node.id}>
              <circle
                cx={node.cx}
                cy={node.cy}
                r={nodeRadius}
                fill={isHighlighted ? 'var(--accent)' : 'var(--surface)'}
                stroke={isOwnerGate ? 'var(--accent)' : 'var(--border)'}
                strokeWidth={isOwnerGate ? 2.5 : 1.5}
              />
              <text
                x={node.cx}
                y={node.cy}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={compact ? 9 : 11}
                fill={isHighlighted ? 'white' : 'var(--text-main)'}
                fontFamily="var(--font-sans)"
              >
                {t(node.labelKey)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
