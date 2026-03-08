# Design System Reference

Comprehensive design system for the unfirehose dashboard. Tailwind v4 + CSS custom properties. Dark-first, monospace-only, CSS Grid layout.

Live reference: `localhost:3000/styleguide`

Diagrams: `docs/design-system.dot` (token architecture), `docs/component-states.dot` (state machines)

## Architecture

```
globals.css (@theme inline)
├── Surface Tokens ──────── background, surface, surface-hover
├── Semantic Tokens ─────── foreground, muted, border, error
├── Role Tokens ─────────── accent, user, assistant, thinking, tool
├── Font Tokens ─────────── --font-sans (Geist Sans), --font-mono (Geist Mono)
└── :root.light ─────────── Light mode overrides (all tokens)

ThemeProvider (packages/ui)
├── Fetches settings on mount
├── Applies --color-accent from DB
├── --color-assistant tracks accent
└── classList toggle for light/dark

Tailwind v4
├── @theme inline — tokens available as utilities (bg-background, text-accent, etc.)
├── No tailwind.config — everything in CSS
└── postcss.config.mjs — @tailwindcss/postcss plugin only
```

## Design Tokens

All tokens defined in `apps/web/src/app/globals.css` inside `@theme inline {}`. Tailwind v4 reads them directly — no config file needed.

### Surface Tokens

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--color-background` | `#09090b` | `#fafafa` | Page base, input backgrounds |
| `--color-surface` | `#18181b` | `#f4f4f5` | Cards, panels, tooltips |
| `--color-surface-hover` | `#27272a` | `#e4e4e7` | Hover states on surfaces |

### Semantic Tokens

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--color-foreground` | `#fafafa` | `#09090b` | Primary text |
| `--color-muted` | `#a1a1aa` | `#71717a` | Secondary text, captions, labels |
| `--color-border` | `#3f3f46` | `#d4d4d8` | All borders, dividers |
| `--color-error` | `#f87171` | `#dc2626` | Error states, danger actions |

### Role Tokens

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--color-accent` | `#d40000` | `#d40000` | User-customizable global accent. Buttons, highlights, charts |
| `--color-user` | `#60a5fa` | `#2563eb` | User message borders, labels |
| `--color-assistant` | tracks accent | `#059669` | Assistant message borders (dark tracks accent) |
| `--color-thinking` | `#a78bfa` | `#7c3aed` | Thinking block borders, labels |
| `--color-tool` | `#fbbf24` | `#d97706` | Tool call borders, labels |

### Font Tokens

| Token | Value | Usage |
|---|---|---|
| `--font-sans` | `var(--font-geist-sans)` | Not used — everything is mono |
| `--font-mono` | `var(--font-geist-mono)` | All text via `font-family: var(--font-mono), monospace` |

### Custom Accent Color

The accent color is user-configurable:

1. **Styleguide/Settings** — HSL slider + hex input
2. **Persist** — `POST /api/settings { key: 'theme_accent_color', value: '#hex' }`
3. **Apply** — `document.documentElement.style.setProperty('--color-accent', hex)`
4. **Propagate** — `ThemeProvider` loads on mount, applies to all pages
5. **Track** — `--color-assistant` updates to match accent in dark mode

Color picker uses `hslToHex(h, 0.7, 0.55)` for gradient stops matching actual output colors.

## Typography

Monospace-only. All text renders in Geist Mono. This creates a consistent code-editor aesthetic across the entire dashboard.

### Type Scale

| Class | Size | Weight | Usage |
|---|---|---|---|
| `text-2xl font-bold` | 1.5rem | 700 | Page headings |
| `text-lg font-bold` | 1.125rem | 700 | Section headings |
| `text-base font-bold` | 1rem | 700 | Card titles, inline headings |
| `text-base` | 1rem | 400 | Body text (default) |
| `text-base text-muted` | 1rem | 400 | Captions, secondary content |
| `text-sm` | 0.875rem | 400 | Badge labels, helper text |
| `text-sm font-bold` | 0.875rem | 700 | Sub-section headers |
| `text-xs` | 0.75rem | 400 | Timestamps, counters, tiny labels |
| `text-[10px]` | 10px | 400 | Section dividers (e.g., sidebar groups) |

### Markdown Content

The `.md-content` class in globals.css styles rendered markdown:

| Element | Style |
|---|---|
| h1 | 1.5rem bold, 1rem margin top |
| h2 | 1.25rem bold, accent color |
| h3 | 1.1rem bold |
| p | 0.35rem margin |
| ul/ol | disc/decimal, 1.5rem padding-left |
| code (inline) | accent color, bg-background, 3px radius |
| pre | bg-background, 6px radius, 0.75rem padding |
| blockquote | 3px left border, muted color |
| a | user color, underline |
| table | border-collapse, border cells |
| th | bg-surface, bold |

## Shape System

Three corner radius tiers:

| Tier | Class | Radius | Usage |
|---|---|---|---|
| Standard | `rounded` | 6px | Cards, inputs, buttons, code blocks, progress bars |
| Medium | `rounded-lg` | 8px | Modals, larger panels, vault input |
| Large | `rounded-xl` | 12px | Kanban cards, vault gate container, hero elements |
| Full | `rounded-full` | 50% | Status dots, pills, scrollbar thumb |

Scrollbar thumb: `border-radius: 4px`. Inline code: `3px`.

## Elevation

Dark-first design uses border-based elevation. Shadows are reserved for interactive lift and emphasis.

| Level | Class | Usage |
|---|---|---|
| 0 | `shadow-none` | Static content, table rows, most elements |
| 1 | `shadow-md` | Kanban cards at rest, dropdowns |
| 2 | `shadow-lg` | Active kanban cards, popovers |
| 3 | `shadow-2xl` | Dragged items, modals, vault gate |
| Glow | `shadow-[0_0_12px_var(--color-accent)]` | RUNNING state kanban cards |

Vault gate uses special elevation: `box-shadow: 0 0 60px rgba(239, 68, 68, 0.08), 0 25px 50px rgba(0,0,0,0.5)` plus a radial-gradient glow backdrop with `blur-[100px]`.

## Spacing Scale

4px base unit. All spacing uses Tailwind's default 4px scale.

| Unit | Pixels | Common Usage |
|---|---|---|
| 0.5 | 2px | Tight inline gaps (icon+text in badges) |
| 1 | 4px | Minimal separation (list items, badge py) |
| 1.5 | 6px | Input py, checkbox label gap |
| 2 | 8px | Standard gap between related items |
| 3 | 12px | Card padding, section gaps, input px |
| 4 | 16px | Card padding, grid gaps, section spacing |
| 6 | 24px | Page padding, major section margins |
| 8 | 32px | Page-level vertical rhythm (`space-y-8`) |

## Layout — CSS Grid Only

No flexbox anywhere. All layouts use CSS Grid.

### Grid Patterns

| Pattern | Usage |
|---|---|
| `grid-cols-[auto_1fr]` | Label + content. Labels get priority (never truncated), content fills remaining space. |
| `grid-cols-[auto_1fr_auto]` | Three-column with priority labels on both sides. |
| `grid grid-flow-col auto-cols-max` | Inline groups. Items flow left-to-right, each sized to content. |
| `grid grid-cols-N` | Equal columns (N = 1, 2, 3, 4, 6). |
| `grid grid-cols-1 md:grid-cols-2` | Responsive 1→2 columns at md breakpoint. |
| `grid grid-cols-1 md:grid-cols-3` | Stat cards, kanban columns. |
| `grid grid-cols-3 md:grid-cols-6` | Badges, color swatches. |

### Root Layout

```
┌─────────────────────────────────────────┐
│ Sidebar (w-72)  │  Main Content         │
│ shrink-0        │  flex-1 overflow-auto  │
│ bg-surface      │  p-6                   │
│ border-r        │                        │
│ h-screen        │  space-y-8 sections    │
│                 │                        │
│ [section label] │                        │
│  ● Live         │                        │
│  ▸ Active       │                        │
│                 │                        │
│ [section label] │                        │
│  ◇ Dashboard    │                        │
│  ■ Projects     │                        │
└─────────────────────────────────────────┘
```

## Responsive Breakpoints

Mobile-first with Tailwind v4 defaults.

| Breakpoint | Width | Behavior |
|---|---|---|
| default | 0px | 1 column, sidebar hidden |
| `sm` | 640px | Small tablets, minor adjustments |
| `md` | 768px | Sidebar visible, 2-col grids |
| `lg` | 1024px | Full dashboard, 3-col grids |
| `xl` | 1280px | Wide monitors, 4-col card grids |
| `2xl` | 1536px | Ultra-wide, no max-w constraint |

Grid columns adapt: `grid-cols-1 md:grid-cols-2 xl:grid-cols-4` is the common card pattern.

## Iconography

No icon library. All navigation and status icons are Unicode text symbols. This provides zero font loading, zero bundle cost, and consistent rendering across platforms.

### Navigation Icons

| Icon | Label | Section |
|---|---|---|
| `●` | Live | monitor |
| `▸` | Active | monitor |
| `◇` | Dashboard | navigate |
| `■` | Projects | navigate |
| `☰` | Todos | navigate |
| `◈` | Graph | navigate |
| `◎` | Thinking | analyze |
| `≡` | All Logs | analyze |
| `¤` | Tokens | analyze |
| `△` | Usage | analyze |
| `♪` | Scrobble | configure |
| `{` | Schema | configure |
| `◐` | Styleguide | configure |
| `⚙` | Settings | configure |

### Status Icons

| Icon | Usage |
|---|---|
| `●` | Active / running (accent color) |
| `○` | Inactive / pending (muted) |
| `◉` | In progress (amber #fbbf24) |
| `◆` | Badge earned (tier color) |
| `◇` | Badge locked (muted, 50% opacity) |

Active nav: `text-[var(--color-accent)]`. Inactive: `text-[var(--color-border)]`.

Running pulse: `w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse`.

## Motion & Animation

All animations use `ease-out` easing. Animations serve feedback, not decoration.

### Duration Scale

| Duration | Name | Usage |
|---|---|---|
| 150ms | Micro | Color transitions, opacity, hover states |
| 200ms | Short | Output expand (`output-expand`), content reveal |
| 350ms | Medium | Card scale-in (`card-scale-in`), capacitor flash |
| 400ms | Medium+ | Column pulse, powerup flash |
| 600ms | Long | Card-landed burst, powerup particles |
| 700ms | Long+ | Powerup sparks |
| 900ms | Extended | Slow particles, ambient effects |
| 4000ms | Ambient | Vault pulse glow (loops infinitely) |

### Animation Catalog

| Animation | Duration | Description |
|---|---|---|
| `card-landed` | 0.6s | Drop burst — accent/green glow ring expanding outward |
| `card-scale-in` | 0.35s | Scale from 0.92 + slight rotate, overshoot to 1.03, settle to 1.0 |
| `burst-particle` | varies | Translate outward from origin + fade to 0 opacity |
| `powerup-particle` | 0.6s | Scale 1.5→0, translate to CSS var endpoint, explosion pattern |
| `powerup-particle-slow` | 0.9s | Same but slower, lower initial opacity |
| `powerup-spark` | 0.7s | Rotated line trails moving outward, scaleX shrink |
| `powerup-shockwave` | 0.6s | Border ring expanding 0→200px, border thins, fades |
| `powerup-flash` | 0.4s | White blur circle, expands then shrinks rapidly |
| `capacitor-core` | 0.35s | White core with box-shadow glow, shrinks to 4px, fades |
| `capacitor-ring` | 0.4s | Border ring expanding 0→160px (power-down effect) |
| `capacitor-screen` | 0.25s | Full-screen white overlay fading to transparent |
| `column-pulse` | 0.4s | Accent 5% tint background flash (kanban column) |
| `output-expand` | 0.2s | `max-height: 0→60vh` + opacity fade-in |
| `vaultPulse` | 4s | Radial gradient scale 1→1.15, opacity 0.12→0.2 (infinite loop) |

### CSS Classes

| Class | Animation |
|---|---|
| `.card-landed` | `card-landed 0.6s ease-out, card-scale-in 0.35s ease-out` |
| `.column-drop-pulse` | `column-pulse 0.4s ease-out` |
| `.output-reveal-inline` | `output-expand 0.2s ease-out` + accent border-top |
| `.powerup-particle` | `powerup-particle 0.6s ease-out forwards` |
| `.powerup-particle-slow` | `powerup-particle-slow 0.9s ease-out forwards` |
| `.powerup-spark` | `powerup-spark 0.7s ease-out forwards` (2×8px with 1px radius) |
| `.powerup-shockwave` | `powerup-shockwave 0.6s ease-out forwards` |
| `.powerup-flash` | `powerup-flash 0.4s ease-out forwards` + `blur(8px)` |
| `.capacitor-core` | `capacitor-core 0.35s ease-out forwards` (white bg) |
| `.capacitor-ring` | `capacitor-ring 0.4s ease-out forwards` (white/70% border) |
| `.capacitor-screen` | `capacitor-screen 0.25s ease-out forwards` |

## Interaction States

### Element States

| State | Visual Treatment |
|---|---|
| Enabled | Default border (`var(--color-border)`) |
| Hover | Accent border, 150ms transition |
| Focused | 1px accent outline, offset -1px |
| Active | Scale 0.98 on press |
| Disabled | 50% opacity, `cursor-not-allowed` |

### Drag States (Kanban)

| State | Visual Treatment |
|---|---|
| Grabbable | `cursor-grab` (default resting) |
| Grabbing | `cursor-grabbing`, `scale-[1.03]`, `rotate-1` (lifted) |
| Ghost | `opacity-30`, `scale-90`, `rotate-2` (source placeholder) |
| Drop Zone | 2px dashed accent border, accent/10 background |
| Landed | `card-landed` + `card-scale-in` animations + particle burst |

### Selection & Focus

- Text selection: `::selection` with `color-mix(in srgb, var(--color-accent) 25%, transparent)`
- Focus rings: `outline: 1px solid var(--color-accent)` with `outline-offset: -1px`
- Checkbox accent: `accent-[var(--color-accent)]`
- Tab order follows DOM order (no `tabindex` hacks)
- Escape closes modals (vault gate, tmux viewer)

## Components

### Card

```
bg-[var(--color-surface)]
rounded
border border-[var(--color-border)]
p-4

Hover variant: hover:border-[var(--color-accent)] transition-colors
Error variant: border-[var(--color-error)] text-[var(--color-error)]
Accent variant: border-[var(--color-accent)]
```

### Buttons

| Variant | Classes |
|---|---|
| Primary | `px-3 py-1.5 text-base bg-accent text-background rounded font-bold hover:opacity-90` |
| Secondary | `px-3 py-1.5 text-base bg-surface-hover border border-border rounded hover:border-accent` |
| Danger | `px-3 py-1.5 text-base text-error border border-error rounded hover:bg-error hover:text-foreground` |
| Disabled | `px-3 py-1.5 text-base text-muted opacity-50 cursor-not-allowed` |

### Inputs

```
px-2 py-1.5 text-base
bg-[var(--color-background)]
border border-[var(--color-border)]
rounded
text-[var(--color-foreground)]

Focus: outline 1px solid var(--color-accent), offset -1px
```

Select dropdowns: custom SVG chevron background-image, `appearance: none`, 28px padding-right.

### Border Indicators

Left border (2-3px) indicates message role/type:

| Role | Border Color | Label Color |
|---|---|---|
| User | `var(--color-user)` | blue |
| Assistant | `var(--color-assistant)` | accent |
| System | `var(--color-muted)` | gray |
| Thinking | `var(--color-thinking)` | purple |
| Tool | `var(--color-tool)` | amber |

### Progress Bar

```
grid grid-cols-[3rem_1fr_3rem] items-center gap-3

Track: h-3 bg-surface-hover rounded overflow-hidden
Fill:  h-full bg-accent rounded transition-all
```

### TimeRangeSelect

Shared dropdown used on all pages. Options: 1h, 3h, 6h, 12h, 24h, 7d, 14d, 28d, Lifetime.

```tsx
import { TimeRangeSelect, useTimeRange, getTimeRangeFrom } from '@unturf/unfirehose-ui/TimeRangeSelect';

const [range, setRange] = useTimeRange('my_page_range', '7d');
const from = getTimeRangeFrom(range); // ISO string or undefined
```

Persists selection in `localStorage` via the hook's key parameter.

### Kanban Card

```
rounded-xl                          // large radius
border border-[var(--color-border)]
p-3.5
shadow-md                           // resting elevation
cursor-grab

Background: color-mix(in srgb, var(--color-accent) 6%, var(--color-surface))
Active: shadow-lg shadow-[0_0_12px_var(--color-accent)], accent/50 border
Completed: rounded-lg (smaller), line-through, muted text, accent 4% tint
```

### Badge Card

```
Earned:  ◆ filled, tier color border, bg-surface
Locked:  ◇ hollow, opacity-50, bg-background, progress bar
```

Tier colors: bronze `#cd7f32`, silver `#c0c0c0`, gold `#ffd700`, diamond `#b9f2ff`.

### Heatmap

Pure CSS Grid. Rows = days (Sun-Sat), columns = hours (0-23). Cell intensity via `color-mix`:

```
color-mix(in srgb, var(--color-accent) ${intensity}%, var(--color-surface))
```

Grid: `inline-grid gap-0.5`, template columns: `auto repeat(24, 1fr)`. Cell size: `w-5 h-5 rounded-sm`.

## Data Visualization

### Chart Library

Recharts for complex charts (Bar, Pie, Area). Pure CSS for simple visualizations (horizontal bars, heatmaps, sparklines).

### Color Assignment

| Role | Color | Usage |
|---|---|---|
| Primary metric | `var(--color-accent)` | Bar charts, area fills, single-series |
| Input tokens | `#22c55e` (green-500) | Horizontal bar input segment |
| Output tokens | `var(--color-accent)` | Horizontal bar output segment |
| Pie series | `#d40000, #60a5fa, #fbbf24` | Accent → user → tool rotation |

### Chart Typography (globals.css overrides)

All chart text forced via `!important` to match theme:

| Element | Size | Color |
|---|---|---|
| Axis labels | 16px | `#71717a` (muted) |
| Tooltip label | 16px bold | `#fafafa` (foreground) |
| Tooltip values | 16px semi-bold | `#fafafa` |
| Tooltip item names | — | `#a1a1aa` (muted) |
| Legend text | 16px | `#d4d4d8` |
| Pie labels | 16px | `#d4d4d8` |

### Tooltip Styling

```css
background: #18181b (surface)
border: 1px solid #3f3f46 (border)
border-radius: 6px
padding: 8px 12px
box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6)
```

Light mode swaps via `:root.light` overrides to light surface/text.

### Horizontal Bar Chart (CSS Grid)

No Recharts needed. Uses `grid-cols-[auto_1fr]` pattern:

```
Label (auto) | Bar track (1fr)
                └── Stacked segments via inner grid
                    gridTemplateColumns: ${input}fr ${output}fr
```

## Accessibility

### Contrast Ratios (Dark Mode)

| Pair | Ratio | WCAG AA |
|---|---|---|
| Foreground (#fafafa) on Background (#09090b) | 17.4:1 | Pass |
| Muted (#a1a1aa) on Background (#09090b) | 7.2:1 | Pass |
| Accent (#d40000) on Background (#09090b) | 4.8:1 | Pass |
| Muted (#a1a1aa) on Surface (#18181b) | 5.7:1 | Pass |

Note: Custom accent colors may reduce contrast. The accent is user-controlled — no enforcement.

### Keyboard Navigation

- All interactive elements natively focusable (button, input, select, a, [draggable])
- Focus ring: 1px accent outline, visible on all backgrounds
- Tab order follows DOM order
- Escape closes modals (vault gate, tmux viewer)
- Enter/Space activates buttons and toggles

### Touch Targets

- Buttons: minimum `py-1.5` (36px clickable height)
- Sidebar links: full-width click area
- Kanban cards: entire card surface is draggable
- Scrollbar: 8px width (adequate for touch)

### Motion

- All animations are decorative — no information conveyed solely through motion
- Future improvement: respect `prefers-reduced-motion` media query

## Scrollbar

Custom webkit scrollbar matching the theme:

```css
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--color-background); }
::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--color-muted); }
```

Light mode overrides swap to light surface colors.

## Theme System

### Dark Mode (Default)

Active by default. No class needed on `:root`.

### Light Mode

Activated via `document.documentElement.classList.add('light')`. All tokens swap to light values defined in `:root.light {}`.

### ThemeProvider

`packages/ui/components/ThemeProvider.tsx`:

1. Mounts, fetches `/api/settings`
2. If `theme_accent_color` exists, applies via `setProperty`
3. Also applies `--color-assistant` to match
4. Light/dark toggle reads `localStorage.unfirehose_light_mode`

### Recharts Light Mode

Separate `:root.light` overrides in globals.css (lines 280-310) swap tooltip, legend, and scrollbar colors to light palette.

## File Map

| File | Purpose |
|---|---|
| `apps/web/src/app/globals.css` | All tokens, animations, recharts overrides, markdown styles, scrollbar |
| `apps/web/src/app/layout.tsx` | Geist Mono font setup, root structure |
| `apps/web/src/app/styleguide/page.tsx` | Live design reference (22 sections) |
| `apps/web/postcss.config.mjs` | Tailwind v4 (`@tailwindcss/postcss`) |
| `packages/ui/components/ThemeProvider.tsx` | Theme loading and accent color application |
| `packages/ui/components/layout/Sidebar.tsx` | Navigation with Unicode icons and section groups |
| `packages/ui/components/viewer/MessageBlock.tsx` | Message rendering with role-based borders |
| `packages/ui/components/TimeRangeSelect.tsx` | Shared time range dropdown |
| `packages/ui/components/PageContext.tsx` | Page metadata + reverse RAG context |
