# Design System: Serene Technical Minimalism (Website-Aligned)

This document codifies the brand colors, typography, layout rules, and aesthetic directives for the **Principles Disciple (PD)** promo video, fully aligned with the PD website's dark-mode design language.

## Color Palette

- `--bg-deep`: `#050608` (Main backdrop — deep, oppressive space)
- `--bg-surface`: `#13151A` (Card/panel backgrounds — matches website dark `.pd-card`)
- `--text-main`: `#E0E2E6` (Primary high-contrast clinical white/gray text)
- `--text-dim`: `#8A8F99` (Secondary muted text — matches website `--text-secondary`)
- `--text-muted`: `#555960` (Tertiary dimmed text — matches website `--text-muted`)
- `--accent`: `#7EB8DA` (Single accent — softer blue-cyan, matching website dark mode)
- `--accent-dim`: `rgba(126, 184, 218, 0.10)` (Accent tint for badges/pills)
- `--accent-border`: `rgba(126, 184, 218, 0.12)` (Accent-tinted borders)
- `--brand-gradient-start`: `#38bdf8` (Sky blue — used ONLY in favicon-grade brand moments)
- `--brand-gradient-end`: `#a855f7` (Purple — used ONLY in favicon-grade brand moments)
- `--pain-muted`: `rgba(180, 80, 80, 0.85)` (Muted red — pain/collision, NOT neon)
- `--border`: `rgba(255, 255, 255, 0.06)` (Subtle structural borders)
- `--card-radius`: `14px` (Matches website 16px with slight reduction for video scale)

## Typography

- **Heading Font:** `'Inter', 'Noto Sans SC', system-ui, sans-serif` (Website-matching humanist sans + CJK)
- **Code Font:** `'JetBrains Mono'`, monospace (Sharp monospace for technical content)
- **Heading Weight:** `400` (Ultra-light, editorial feel — matches website H1/H2 pattern)
- **Letter-spacing:** `-0.025em` for H1, `-0.015em` for H2 (matches website `clamp()` headings)

## Brand Elements

### Friction Node
A recurring 6-8px circle, accent-colored, 50% opacity. Used as a visual marker throughout badges, pain triggers, and the final anchor scene. Represents the core "Constructive Friction" concept.

### Mono Badge (Section Tag)
Pill-shaped label with:
- `border-radius: 99px`
- `background: var(--accent-dim)`
- `border: 1px solid var(--accent-border)`
- `font: JetBrains Mono, 12px, uppercase, letter-spacing 0.1em`
- `color: var(--accent)`
- Friction node dot + uppercase text

### Brand Gradient
The `#38bdf8 → #a855f7` gradient is reserved exclusively for:
- Scene 3 scan-line (compilation sweep)
- Favicon echo moments
- NOT for general UI decoration

## Styling Directives

- **Transitions:** Every scene transition uses **Deep Space Crossfade** (smooth dissolves with heavy CSS backdrop blur layers).
- **Background Texture:** Persistent, high-frequency, low-opacity SVG noise overlay (`opacity: 0.03`).
- **Card Style:** Flat surface (`background: var(--bg-surface)`) + `1px solid var(--border)` — NO glassmorphism, NO box-shadows (matches website `.pd-card` pattern).
- **Contrast Check:** Ensure contrast between text and background elements exceeds **4.5:1** (WCAG AA).

## Anti-patterns & Forbidden Elements

- **No white backgrounds** (or light themes) whatsoever.
- **No cheerful, bouncy animations** (use cinematic ease curves only).
- **No rounded, bubbly fonts** or high border-radii on non-badge elements.
- **No generic 3D/flat SaaS illustrations.**
- **No multi-color neon accents** — single accent system only, with brand gradient exceptions.
- **No heavy box-shadows** on cards or panels.
- **No backdrop-filter/glassmorphism** on cards (reserved for navigation-tier elements only).
