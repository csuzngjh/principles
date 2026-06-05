import * as React from "react";
import { Button } from "../../components/ui/button.js";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "../../components/ui/card.js";
import { Badge } from "../../components/ui/badge.js";
import { PageShell } from "../../components/layout/page-shell.js";
import { SectionTitle } from "../../components/layout/section-title.js";

/**
 * Design system preview page — dev-only visual regression anchor.
 * Renders all tokens, component states, and patterns for CR1 verification.
 */

const LIGHT_TOKENS = [
  { name: "--paper", value: "#f7f3ea" },
  { name: "--paper-2", value: "#f2ede3" },
  { name: "--surface", value: "#fbf8f0" },
  { name: "--panel", value: "#fffdf7" },
  { name: "--ink", value: "#1f2933" },
  { name: "--ink-2", value: "#384150" },
  { name: "--ink-3", value: "#525966" },
  { name: "--ink-4", value: "#5F6774" },
  { name: "--line", value: "#d7d1c4" },
  { name: "--line-2", value: "#c7bfaf" },
  { name: "--gov", value: "#1e3a5f" },
  { name: "--gov-2", value: "#2f557f" },
  { name: "--amber", value: "#a66a2a" },
  { name: "--green", value: "#4d6b52" },
  { name: "--danger", value: "#8b3a3a" },
];

export function DesignSystemPage() {
  return (
    <PageShell>
      <SectionTitle>Design System Preview</SectionTitle>
      <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
        Warm Paper + Blueprint
      </h1>
      <p className="text-ink-3 text-sm mb-8">
        Visual regression anchor for CR1. All tokens and component states rendered here.
      </p>

      {/* Color Palette */}
      <SectionTitle>Color Palette</SectionTitle>
      <div className="grid grid-cols-5 gap-3 mb-8">
        {LIGHT_TOKENS.map(({ name, value }) => (
          <div key={name} className="flex flex-col items-center gap-1">
            <div
              className="w-full h-12 rounded-[var(--radius-md)] border border-line"
              style={{ backgroundColor: value }}
            />
            <span className="font-mono text-[10px] text-ink-3">{name}</span>
            <span className="font-mono text-[10px] text-ink-4">{value}</span>
          </div>
        ))}
      </div>

      {/* Buttons */}
      <SectionTitle>Buttons</SectionTitle>
      <div className="flex flex-wrap gap-3 mb-8 items-center">
        <Button variant="default">Primary (Gov)</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="quiet">Quiet</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
        <Button variant="default" disabled>Disabled</Button>
        <Button variant="default" size="sm">Small</Button>
        <Button variant="default" size="lg">Large</Button>
      </div>

      {/* Cards */}
      <SectionTitle>Cards</SectionTitle>
      <div className="grid grid-cols-2 gap-4 mb-8">
        <Card>
          <CardHeader>
            <CardTitle>Default Card</CardTitle>
            <CardDescription>With shadow, hover deepens border + shadow. No transform.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-ink-3">
              Cards use <code className="font-mono text-[11px] bg-paper-2 px-1 rounded-[2px]">--shadow-card</code> and
              hover with deeper shadow. No translateY or scale on hover (B.4.4).
            </p>
          </CardContent>
          <CardFooter>
            <Button variant="default" size="sm">Action</Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Card with Badges</CardTitle>
            <CardDescription>Status labels in Blueprint style</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2 mb-3">
              <Badge variant="default">待审查</Badge>
              <Badge variant="amber">需注意</Badge>
              <Badge variant="green">稳定</Badge>
              <Badge variant="destructive">风险</Badge>
              <Badge variant="secondary">已归档</Badge>
              <Badge variant="outline">已暂存</Badge>
            </div>
            <p className="text-sm text-ink-3">
              Badges: 2px border-radius, mono font, 11px, low saturation (B.4.5).
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Badges */}
      <SectionTitle>Badges / Status Labels</SectionTitle>
      <div className="flex flex-wrap gap-3 mb-8">
        <Badge variant="default">待审查</Badge>
        <Badge variant="amber">需注意</Badge>
        <Badge variant="green">稳定</Badge>
        <Badge variant="destructive">风险</Badge>
        <Badge variant="secondary">已归档</Badge>
        <Badge variant="outline">已暂存</Badge>
      </div>

      {/* Empty State */}
      <SectionTitle>Empty State</SectionTitle>
      <Card className="mb-8">
        <CardContent className="py-12 text-center">
          <p className="text-ink-3 text-sm mb-2">
            还没有可审查原则。当 PD 捕获到行为偏差信号时，会在这里生成原则候选，等待你审查。
          </p>
          <Button variant="outline" size="sm">了解更多</Button>
        </CardContent>
      </Card>

      {/* Error State */}
      <SectionTitle>Error State</SectionTitle>
      <Card className="mb-8">
        <CardContent className="py-8">
          <p className="text-ink-3 text-sm mb-2">
            无法加载这条原则的证据来源。原则本身未受影响。你可以稍后重试，或暂时保留在待审查状态。
          </p>
          <Button variant="outline" size="sm">重试</Button>
        </CardContent>
      </Card>

      {/* Typography */}
      <SectionTitle>Typography</SectionTitle>
      <div className="space-y-3 mb-8">
        <h1 className="text-[29px] font-semibold tracking-tight text-ink">Page Title — 29px</h1>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">Card Title — 17px</h2>
        <h3 className="text-[13px] font-semibold text-ink-2">Section Title — 13px</h3>
        <p className="text-[15px] text-ink leading-relaxed">Body text — 15px. The quick brown fox jumps over the lazy dog. 数字使用 tabular-nums: 1,234,567.</p>
        <p className="text-[14px] text-ink-2">Card body — 14px</p>
        <p className="text-[13px] text-ink-3">Auxiliary text — 13px</p>
        <p className="font-mono text-[11px] tracking-[0.1em] uppercase text-ink-3">EYEBROW / LABEL — 11PX MONO</p>
        <p className="font-mono text-[11px] text-ink-4">Metadata / timestamp — 11px mono</p>
      </div>

      {/* 712px Container */}
      <SectionTitle>Layout — 712px Container</SectionTitle>
      <p className="text-sm text-ink-3 mb-4">
        This page is already inside a PageShell (712px centered). The blueprint grid is visible on the body background.
      </p>
      <div className="border border-dashed border-line-2 p-4 text-center text-ink-4 text-xs font-mono">
        ← 712px max-width →
      </div>
    </PageShell>
  );
}
