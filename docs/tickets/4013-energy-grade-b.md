# 4013: Energy audit to grade B — counters and request ids, no new hardware

**Status:** our side shipped 2026-10-26 (items 1 to 4 and 6; item 5 waits for the proxy's events); fox's three node steps open
**Project:** unfirehose-nextjs-logger
**Estimated:** two sessions for our side; fox's steps are minutes each
**Owner:** web session; fox for the node-side steps

## What grade B means

| grade | energy source | timing source |
|---|---|---|
| A | wall meter plus NVML and RAPL counters | per-request ids |
| **B** | **NVML and RAPL cumulative energy counters** | **per-request ids** |
| C | 15-second power samples integrated | bucket share by tokens |
| D | throughput constants | none |

Today everything is C or D. B needs no purchase: both chips carry cumulative
energy counters, and differencing a counter between two reads gives exact
joules for the interval whatever the sampling rate. Measured on
2026-10-26: the 3090 box already has RAPL world-readable; the 4090 has it
root-only (mode 0400); neither box has the NVML Python bindings; RAPL wraps
at `max_energy_range_uj` = 262,143,328,850 µJ, about an hour at 80 W.

## fox's three steps, on the nodes

1. **NVML bindings**, each GPU box: `python3 -m pip install --user nvidia-ml-py`.
   Then this must print two numbers and a delta:
   ```
   python3 -c 'import pynvml as n,time; n.nvmlInit(); h=n.nvmlDeviceGetHandleByIndex(0); a=n.nvmlDeviceGetTotalEnergyConsumption(h); time.sleep(1); print(a, n.nvmlDeviceGetTotalEnergyConsumption(h))'
   ```
   If it raises NotSupported on the 4090, say so on this ticket; GeForce
   boards since Volta report it, but that is the one thing we could not
   verify without the module.
2. **RAPL readable on the 4090**, the way the 3090 already is. Persistent
   across boots with a tmpfiles rule, as root:
   ```
   printf 'z /sys/class/powercap/intel-rapl:0/energy_uj 0444 - - -\n' > /etc/tmpfiles.d/rapl.conf
   systemd-tmpfiles --create /etc/tmpfiles.d/rapl.conf
   ```
   (The kernel made it 0400 after the PLATYPUS side-channel paper; on a
   box we own, reading our own power is the point.)
3. **A request id from the proxy.** When the key-holding proxy (4012 item
   15) forwards to vLLM, set `X-Request-Id` to its own id; vLLM echoes it
   and uses it in its request log, so proxy record and engine log join on
   it. The proxy record per request: id, lane, key id, model, node, start,
   first-token time, end, prompt tokens, generated tokens, cache hits,
   finish reason, status.

## Our side

### 1. Store the counters, not just the watts
`mesh_snapshots` gains `cpu_energy_uj` (sum over RAPL packages, raw) and
`gpu_energy_mj` (NVML total, per GPU summed), plus `energy_source` naming
which counters were read. The local probe already reads `energy_uj` twice
100 ms apart for a watts figure; keep the watts for the live cards, and
record the second read's raw value. The remote probe's shell gains the same
two reads, NVML through a one-line python when the module imports and null
when it does not. Nothing else about sampling changes: 15 seconds, same
ssh multiplexer.

### 2. Energy from deltas, with wrap and reset handling
`node_energy_15m` takes a bucket's energy as the counter difference across
the samples in it when counters are present: RAPL wraps to zero past
`max_energy_range_uj`, so a negative delta adds the range; NVML is 64-bit
and resets only when the driver reloads, so a negative delta there is a
reset and the interval is dropped, not guessed. Falls back to power
integration when counters are null. Each row carries `grade` ('B' from
counters, 'C' from power). Tests: a wrap mid-bucket, a driver reload, a
bucket with one counter present and one absent.

### 3. Measured idle
With `running` and `waiting` on the vLLM samples (02a23cb), idle for a node
is the mean draw over intervals where both were zero for the whole
interval, over the trailing week, instead of the p10 percentile that
inflated under load (4012 item 11). Keep the percentile as fallback for a
node without vLLM and label which one was used.

### 4. Tokens at the same cadence as power
Move the vLLM counter read from five minutes to the sampler's 15-second
tick for hosts that answered last time, so token deltas and energy deltas
share bucket edges. Rows per day go from 288 to 5,760 per model; that is
fine for a counters table and the maintenance rollup folds it like the
mesh rows.

### 5. Request-level attribution, once events arrive
Ingest the proxy's request records under a `proxy` harness (4012 item 15).
For each 15-second energy interval on a node, the requests overlapping it
share the interval's marginal energy by measured work: prefill seconds from
first-token time, decode seconds from end minus first-token, each scaled
by the fraction of the request inside the interval. Allocated energy adds
each request's wall-time share of idle. Store per request: marginal_wh,
allocated_wh, grade. A request with no overlapping counter interval gets
grade C from power samples; with no samples, D from constants.

### 6. Fidelity on every number
Every energy figure the dashboard, fleet page, node page and monthly report
show carries its grade, and the report's electricity lines state which
grade their inputs had. Mixed inputs show the lowest grade present.

## Acceptance
- On the 3090 box, which already has RAPL open, `node_energy_15m` rows read
  grade B for CPU within a day of merge without any node-side change.
- With fox's steps 1 and 2 done, the 4090 reads grade B for both chips.
- A seeded test database with proxy request records produces per-request
  marginal and allocated watt-hours whose sum over an interval equals the
  interval's measured energy, to the millijoule.
- Zero `SQLITE_BUSY` under the 15-second vLLM read on a 7 GB database.

## Outcome, our side (blackops, 2026-10-26)

- **1. Counters stored.** Remote probe: the `RAPL` line keeps both raw reads
  and a `RAPLMAX` line carries each package's wrap range; the shared `nvidia`
  fragment adds an `NVML` line (millijoules per GPU) where `python3 -c
  'import pynvml'` succeeds. Local probe: same two values. Node fields
  `cpuEnergy[{uj,max}]`, `gpuEnergyMj`; snapshot columns `cpu_energy_json`,
  `gpu_energy_mj`. Node side: salt state `energy-counters` (foxhop-states
  7a5c3ea) and `make node-energy-prep HOST=` for a box without salt.
- **2. Energy from deltas, graded.** `energy-counters.ts`: RAPL wrap adds the
  package range once; a backwards NVML step is a driver reload and the
  interval is unknown; a GPU box needs both counters to be measured.
  `node_energy_15m.measured_wh/measured_gpu_wh/grade`; cold rows
  `measured_wh/measured_gpu_wh/energy_grade`, summed not smoothed. The
  estimate columns keep their meaning; measured sits beside them.
- **3. Measured idle.** `measuredIdleWindow`: time-weighted mean draw over
  intervals the engine reported empty (running = 0, waiting = 0, report
  under a minute old), trailing week, six quiet hours minimum; else p10.
  `node_energy_15m.idle_source` says which. Replaces item 11 of 4012.
- **4. Tokens at 15 s.** A `knownOnly` vLLM pass runs on the mesh tick for
  hosts whose metrics port was found; discovery stays at five minutes.
- **6. Grade on the read.** `EnergyHost` carries `grade`, `measuredCoverage`,
  `measuredKwh`, `idleSource`; the fleet attribution table shows the grade
  beside each host and marks an estimated idle with `~`.
- **Not done: 5.** Request-level attribution needs the proxy's per-request
  events (4012 item 15). The monthly report does not yet print a grade.

What to expect live: a RAPL-readable box with no GPU (cammy, guile, blanka,
neoblanka) reads grade B within a few buckets of the deploy; the 3090
stays C until `python3-pynvml` is on it; the 4090 stays C until both of
fox's node steps are applied. Buckets before the deploy stay C forever,
since no counter was stored for them.

## Live, 2026-10-26 12:05 UTC, nine minutes after the deploy

| host | RAPL readable | NVML | first bucket grade |
|---|---|---|---|
| guile (2 sockets, no GPU) | yes | n/a | **B**, measured 2.07 Wh against a 4.92 Wh estimate for the same minute |
| 3090-ai | yes | not installed | C: counters on every sample, GPU half missing by design |
| 4090-ai, cammy, blanka, neoblanka | present, mode 0400 | — | C until `state.apply energy-counters` |

The gap between guile's measured and estimated figures is the part no
counter sees: 251 GB of DIMMs, spinning disks and PSU loss, which the
estimate models and RAPL does not. Both numbers are kept; a reader must
not compare one host's B to another's C. vLLM counters now land every 15
seconds on both GPU boxes; zero `SQLITE_BUSY` since the restart. Salt:
`energy-counters` fleet-wide under os:Ubuntu, `energy-counters.nvml` on
the GPU hosts (foxhop-states 6818327), not yet applied.

## Live, 2026-10-29 21:10 UTC, salt applied from akuma

fox: "ok do that from akuma, sudo is passwordless from fox" and "if you think
NVML is needed add it to salt states for our machines". Done from the master
(`sudo -n salt`, file_roots is fox's checkout at `/home/fox/foxhop-states`,
pulled by hand after each push; no gitfs).

- `energy-counters` (RAPL tmpfiles rule) was already converged on every
  Ubuntu minion: the dry run found the file in place fleet-wide, so the
  scheduled highstate had applied foxhop-states 6818327 before we came by
  hand. `python3-pynvml` was already on 4090-ai and 3090-ai the same way.
  That is why 3090 and 4090 have read grade B since 2026-10-27 23:30 UTC.
- cammy was grade C with RAPL readable: its Tesla P40 makes it a GPU host,
  and a GPU host without NVML stays C by design. Attached
  `energy-counters.nvml` to cammy (foxhop-states 4fc071c), applied; the
  NVML line landed in the next snapshot (21:08:59). **The P40 (Pascal,
  driver 580.178.04) does return `nvmlDeviceGetTotalEnergyConsumption`**,
  although NVML documents it for Volta and newer. Test before assuming.
- Step 1 of fox's three steps (pip install per box) is superseded by salt.

| host | RAPL | NVML | grade B since | buckets B / C since 10-26 |
|---|---|---|---|---|
| guile (no GPU, by hand 10-26) | yes | n/a | 2026-10-26 12:00 | 325 / 1 |
| 3090-ai | yes | yes | 2026-10-27 23:30 | 183 / 143 |
| 4090-ai | yes | yes | 2026-10-27 23:30 | 183 / 143 |
| cammy (P40) | yes | yes, 21:09 today | **B** from the 21:15 bucket (first partial read: ~83 W measured against ~160 W estimated, 1.35 Wh of that idle) | 1 / 326 |
| blanka (Fedora 44, not a minion) | yes, fox by hand 2026-10-30 20:38 | n/a | **B** from the 20:45 bucket on 10-30 (first partial read: ~17 W measured against ~33 W estimated) | 1 / 326 |
| neoblanka (this workstation, Ubuntu 24.04, not a minion) | yes, fox by hand 2026-10-30 13:16 | n/a | **B** from the 13:30 bucket on 10-30 (first partial read: ~18 W measured against ~47 W estimated) | 1 / 326 |
| ryu (ai-3060) | — | — | minion offline, no route from here | no data |

Newest grade B bucket per host, measured beside the estimate for the same
quarter hour (measured excludes DIMMs, disks, fans, PSU loss by design):

| host | bucket | measured | estimate | idle |
|---|---|---|---|---|
| 3090-ai | 2026-10-29 21:00 | 11.9 Wh (9.81 Wh GPU) | 23.33 Wh | measured |
| 4090-ai | 2026-10-29 21:00 | 10.98 Wh (7.84 Wh GPU) | 19.41 Wh | measured |
| guile | 2026-10-29 21:00 | 8.91 Wh | 32.69 Wh | p10 |

guile's gap is the largest because its estimate carries 251 GB of DIMMs and
spinning disks; the two GPU boxes come in at roughly half their estimate.
The estimate's non-CPU, non-GPU model (`calcNonCpuWatts`) is now the one
number a wall meter would settle (grade A).

Outstanding for blanka and neoblanka, as root on each (what
`make node-energy-prep HOST=` prints):

```
printf 'z /sys/class/powercap/intel-rapl:0/energy_uj 0444 - - -\nz /sys/class/powercap/intel-rapl:1/energy_uj 0444 - - -\n' > /etc/tmpfiles.d/unfirehose-rapl.conf
systemd-tmpfiles --create /etc/tmpfiles.d/unfirehose-rapl.conf
```

Either fox runs it by hand, or enrols both as minions so `os:Ubuntu` picks
up neoblanka (blanka is Fedora and would need its own target). fox decides.

Every live host reads grade B as of 2026-10-30 20:45 UTC: guile, 3090-ai,
4090-ai and cammy through salt (NVML included), neoblanka and blanka through
fox's by-hand tmpfiles step. Each box flipped on the very next 15 s sample,
with no restart on our side. ryu stays unmeasured until it is back on the
network. Buckets before each box's flip stay C forever, by design.
