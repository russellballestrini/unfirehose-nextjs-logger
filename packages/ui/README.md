# @unturf/unfirehose-ui

Shared React components for [unfirehose](https://github.com/russellballestrini/unfirehose-nextjs-logger) dashboards.

## Install

```bash
npm install @unturf/unfirehose-ui
```

Peer dependencies: `react >= 19`, `react-dom >= 19`, `next >= 15`.

## Components

```tsx
import { PageContext } from '@unturf/unfirehose-ui/PageContext'
import { TimeRangeSelect } from '@unturf/unfirehose-ui/TimeRangeSelect'
import { SessionPopover } from '@unturf/unfirehose-ui/SessionPopover'
import { ThemeProvider } from '@unturf/unfirehose-ui/ThemeProvider'
import { Sidebar } from '@unturf/unfirehose-ui/layout/Sidebar'
import { MessageBlock } from '@unturf/unfirehose-ui/viewer/MessageBlock'
import { useCurrency } from '@unturf/unfirehose-ui/useCurrency'
```

| Component | Purpose |
|---|---|
| `PageContext` | React context for page-level state management |
| `TimeRangeSelect` | Time range picker (1h, 3h, 6h, 24h, 7d, 14d, 28d) |
| `SessionPopover` | Session details popover with metadata |
| `ThemeProvider` | Dark/light theme wrapper |
| `Sidebar` | Navigation sidebar layout |
| `MessageBlock` | Renders message content (text, thinking, tool calls) |
| `useCurrency` | Hook for currency formatting |

## Part of the unfirehose monorepo

| Package | Description |
|---|---|
| [@unturf/unfirehose](https://www.npmjs.com/package/@unturf/unfirehose) | Core data layer |
| [@unturf/unfirehose-schema](https://www.npmjs.com/package/@unturf/unfirehose-schema) | unfirehose/1.0 spec — JSON Schema, TypeScript types |
| [@unturf/unfirehose-router](https://www.npmjs.com/package/@unturf/unfirehose-router) | CLI daemon |
| **@unturf/unfirehose-ui** | Shared React components (this package) |

## License

AGPL-3.0-only
