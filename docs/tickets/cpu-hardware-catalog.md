# Mesh probe: expand known CPU hardware (TDP + release year)

**Repo:** unfirehose-nextjs-logger
**Priority:** Medium
**Status:** DONE

## Problem

`lookupCpuTdp` / `lookupCpuYear` in `packages/core/mesh-probe.ts` drive node
power estimation (when RAPL is absent) and the mesh wisdom score. An unknown
CPU returns null → `powerWatts` undefined → node card prices electricity at
$0 and the monthly total is ISP alone. blanka (i5-3320M) hit this on
2026-09-12.

Also: `probeRemote` chains `grep -m1 "model name" /proc/cpuinfo &&` — on an
aarch64 board (Raspberry Pi, Rockchip, Ampere) there is no `model name`
line, so the whole stats chain fails and the node reads "Unreachable".

## Plan

Tier 1 — generic, sizable market (family-level patterns, one line covers a
generation):
- Intel Core i3–i9 all generations incl. Nehalem "i7 CPU 920" format,
  Core Ultra series 1/2, Core 3/5/7 (2024 rebrand), Core M
- Intel Xeon: 6 (Granite/Sierra), Scalable gen 1–5, Max, W, E5/E3/E7,
  D, E-2xxx, 5500/5600, Phi
- AMD Ryzen desktop (gen-aware X/X3D/G/GE/PRO), mobile (U/HS/H/HX/AI/Z),
  Embedded, Threadripper 1000–9000 + PRO, EPYC 7001–9005, 4004, 8004
- Apple M1–M5 base/Pro/Max/Ultra
- ARM servers: Ampere Altra/AmpereOne, Graviton 2–4, Neoverse, Grace
- SBCs: Raspberry Pi 1–5 by Model line, Rockchip, Amlogic, Allwinner,
  NVIDIA Jetson
- VMs: QEMU/KVM/Hyper-V virtual CPU strings

Tier 2 — long tail, kept because each is one regex and the homelab /
second-life market is real: Core 2, Pentium 4/D/Dual-Core, Atom/Celeron/
Pentium sub-families, AMD FX/Phenom/Athlon/Opteron/A-series/E-series/GX,
Sempron/Turion, IBM POWER, Hygon, Zhaoxin, Loongson, Phytium, Kunpeng,
ThunderX, VIA, RISC-V boards.

Vendor fallbacks last (`Xeon`, `Core i`, `Ryzen`, `Intel`, `AMD`, virtual):
a rough watt figure beats a $0 electricity bill. Wholly unknown strings
still return null.

Probe fixes:
- `(R)`/`(TM)` stripped before matching — real cpuinfo says
  `Core(TM) Ultra 7 155H` and `Core(TM)2 Duo`, which the old patterns never
  matched.
- `parseCpuModel` falls back `model name` → `cpu model` → `Model` →
  `Hardware` → `cpu :` (ppc) → ARM `CPU part` id map.
- Remote probe never fails the chain on a missing `model name`.
- Deep node probe appends `Model`/`Hardware` lines past `head -30`.

## Follow-up (2026-09-12): the userland probe

Goal set by fox: "make a modular plugin style gnu_linux userland tool and
then make one for … all of them … if you leave one behind and somebody
gets ssh working on their cluster only to find the metrics don't show up
they are going to be sad."

Done in `packages/core/userland/` — 20 plugins keyed on `uname -s` (from
Wikipedia's uname table), one Bourne-shell script on stdin to `ssh host
sh`, a PowerShell twin for Windows, one parser for every notation. Design:
`docs/architecture/userland-probe.md`.
