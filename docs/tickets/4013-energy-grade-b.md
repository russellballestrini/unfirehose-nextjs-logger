# 4013: Energy audit to grade B — counters and request ids, no new hardware

**Status:** open; fox has three steps, the web session has the rest
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
