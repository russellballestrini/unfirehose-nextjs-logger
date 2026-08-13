# 4005: Thermal & fan telemetry — full sensor sweep + charts

**Status:** shipped (option **a**) — one follow-up open, see Open questions
**Project:** unfirehose-nextjs-logger
**Estimated:** 3-5 hours
**Proposed by:** fox 2026-08-13

## Context

Our node detail page (`apps/web/src/app/permacomputer/[node]/page.tsx:834`) renders a
`Thermal Zones` section as a flat wrap of `name  temp°C` text:

```
acpitz 87°C   INT3400 Thermal 20°C   SEN1 54.1°C   pch_skylake 73°C
B0D4 87.1°C   iwlwifi_1 54°C   x86_pkg_temp 89°C
```

Three defects live in those seven lines.

**1. Our probe reads one impoverished source.** `apps/web/src/app/api/mesh/node/route.ts:87`
reads only `/sys/class/thermal/thermal_zone*/{temp,type}`, capped at `head -10`. A sweep of
`/sys/class/hwmon/` on neoblanka right now returns strictly more, and better labeled:

| chip | sensors currently missed |
|------|--------------------------|
| `coretemp` | `Package id 0`, `Core 0..3` — **per-core temps, with `crit=100°C`** |
| `nvme` | `Composite` 40.9°C (`crit=84.9`), `Sensor 1` |
| `thinkpad` | `CPU` 86°C, `GPU`, **`fan1 = 3957 RPM`** |

Our fan is spinning at 3957 RPM and our dashboard cannot see it at all. There is no fan
telemetry anywhere on our permacomputer pages.

**2. Colors lie because thresholds are hardcoded.** Current logic is
`>80 red, >60 orange` for every zone equally. So `acpitz 87°C` (a chassis zone with no
declared crit) paints identically to `x86_pkg_temp 89°C` (crit 100°C — genuinely 89% of
the way to throttle). One is ambient noise, one is our machine screaming. hwmon publishes
`tempN_crit` and `tempN_max` per sensor; we should scale to those, not to a magic 80.

**3. No history.** Every other metric on that page charts over time via `UPlotTimeChart`
against `/api/mesh/history`. Temperature — the metric most defined by its trend — is the
only one rendered as a bare instantaneous number.

Reference for the shape we want: `~/git/training.ai.unturf.com/scripts/live-loss-dashboard.html`
(`#infraChart`, `#fansChart`) — dual-axis fan-% + temp-°C line chart, per-series tooltips
explaining what each line means, and an explicit `no fan telemetry` fallback for boxes that
expose none.

## Goal

Our Thermal section reports every sensor our machine exposes, grades each against its own
declared limit, surfaces fan RPM, and charts both over time.

## Required changes

### 1. Probe — full hwmon sweep (`api/mesh/node/route.ts`)

Replace our `SECTION:TEMPS` block with a sweep emitting `chip|key|label|value|crit|max`
per sensor, covering `hwmon*/temp*_input`, `hwmon*/fan*_input`, `hwmon*/pwm*`, and keeping
`/sys/class/thermal/thermal_zone*` for zones hwmon does not mirror (`INT3400`, `SEN1`,
`B0D4`). Drop our `head -10` cap. Single bash blob, no new dependency — `lm-sensors` is not
installed on neoblanka and we should not require it.

**Sanitization is mandatory** — real values off this machine:
- `thinkpad temp3..temp8` read `0` (unpopulated headers) → drop
- `thinkpad temp2` (`GPU`) reads empty → drop
- `nvme temp2 max = 65261850` → 65261°C sentinel garbage → reject any crit/max outside 20..150°C

### 2. Parse → structured sensors

`probe.sensors = { temps: [{chip, label, tempC, critC, maxC}], fans: [{chip, label, rpm, pwmPct}] }`.
Keep our existing `probe.temperatures[]` shape intact — `permacomputer/page.tsx` reads it too.

### 3. UI — rebuild our Thermal section

- Group by chip; per-sensor bar scaled to that sensor's own crit, colored by headroom.
- Headline row: hottest sensor, its % of crit, and fan RPM.
- Fans get a section: RPM + duty %, or an explicit "no fan telemetry" line.
- Charts via existing `UPlotTimeChart`, joined to our page's zoom/cursor `syncKey`.

### 4. Throttle counters — added after fox observed the symptom

Fox: *"I seem to notice when it thermal throttles for sure, you can feel it on mouse
on ubuntu and sound card."* That felt symptom has a counter behind it:

- `/sys/devices/system/cpu/*/thermal_throttle/package_throttle_count` — **6,286,594**
  events since boot on neoblanka, with `package_throttle_total_time_ms` = 24.2 hours
- `cpufreq/scaling_cur_freq` vs `cpuinfo_max_freq` — **1900 / 3600 MHz, 53% of rated clock**

Temperature says how hot; these say what the hot cost us. The counters are monotonic
since boot, so the panel charts a **rise between two polls** as `THROTTLING NOW` and
shows cumulative count separately — an absolute 6.2M says nothing about this second.

### 5. History — shipped as (a)

Client rolling buffer, 1200 points (~2h at our 6s poll), persisted to localStorage per
host. Held in an external store read through `useSyncExternalStore` rather than
`useState` — appending from an effect cascades a second render on every poll, and our
lint rule correctly rejects it.

## Open questions

**Where does sensor history live?** Charts need a time series and we have two paths:

- **(a) Client rolling buffer** — accumulate polls in `localStorage`, same as our reference
  dashboard's `uncloseai-fans-history`. Zero schema change, works immediately, no storage
  growth. But history exists only while a tab watches, and lives per-browser.
- **(b) Persist to `mesh_snapshots`** — add a compact `sensors_json` column, ride our
  existing hot-15s/28d + cold-15m tiering and gaussian rollup. Real cross-device history that
  survives reloads. Costs ~300B/row × 5760 rows/day/node — roughly 240MB across 5 nodes at
  28d retention. Also needs matching columns in `mesh_snapshots_15m` + `mesh-rollup.ts`.

Shipped (a). **(b) remains open.** Note it is a larger change than it first looks: our
mesh-summary poller (`api/mesh/route.ts`) does not collect sensors at all — only our deep
per-node probe does — so persisting history server-side means adding a sensor sweep to
the SSH poller that runs against every node, not just a column.

Neither path can backfill, so (a) loses nothing we could otherwise have had today.

## Notes

Sample sweep from neoblanka at 2026-08-13T18:36Z, while it ran hot:

```
coretemp|temp1|Package id 0|87.0|crit=100
coretemp|temp3|Core 1     |87.0|crit=100
nvme    |temp1|Composite  |40.9|crit=84.9
thinkpad|fan1 |-          |3957 RPM
```

Package at 87 of 100°C with our fan at 3957 RPM is exactly the state our current section
renders as an unremarkable `x86_pkg_temp 89°C` in the same red as a 20°C zone.
