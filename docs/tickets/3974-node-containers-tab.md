# 3974: Containers tab on our node page

**Status:** in-progress
**Project:** unfirehose-nextjs-logger
**Estimated:** 120m
**Todo IDs:** 3974

## Context

fox asked (2026-09-14) for a Containers tab on our node detail page: container
states, a process tree under each container, CPU and RAM with bars and charts —
visibility into containers from our hypervisor node's side.

Our probe already ships `docker ps -a` and `docker inspect` state for a small
Overview card. It has no resource figures and no per-container processes.

## Plan

Measure from our host kernel, not from a container runtime CLI. `docker stats
--no-stream` costs 2.2s and `docker top` costs ~200ms per container (snap CLI
startup) on a probe that polls every 6s. cgroup files cost microseconds.

1. **Probe** (`api/mesh/node/route.ts`)
   - `DOCKER_STATE` grows: root host PID, cpu/mem/pids limits, cpuset,
     restart count, OOMKilled, health. Appended fields, positional parse stays
     backward compatible.
   - `CGROUP_STATS`: for each running container, resolve its cgroup via
     `/proc/<rootpid>/cgroup`, then read `cpu.stat` twice one second apart,
     `memory.current/max/peak`, `memory.stat` (anon, file, inactive_file),
     `memory.events` (oom_kill), `pids.current/max`, `io.stat`, PSI
     `cpu/memory/io.pressure`, and `cgroup.procs` for membership. cgroup v1
     fallback for `cpuacct.usage`, `memory.usage_in_bytes`.
   - `PS_PPID`: `ps -eo pid,ppid,user,pcpu,pmem,rss,etimes,args` for every
     host process, so a container's tree is built from host PIDs and PPIDs.
2. **Parser** (`lib/node-probe.ts`): `parseCgroupStats`, `parsePsPpid`,
   extended `parseDockerState`; `attachContainerResources` marries stats and
   process subtrees onto each container row.
3. **UI** (`permacomputer/[node]/tabs.tsx`): `ContainersTab`
   - Summary: state donut, CPU share and memory share across containers.
   - Per-container card: status (reuses `containerStatus`), image, ports,
     CPU bar (vs cores or quota), memory bar (vs limit or host), PIDs bar
     (vs pids.max), IO, PSI, OOM and restart flags, and its host process
     tree with per-process CPU/MEM/RSS.
4. Tests for every parser and the tab. Tab registered in `page.tsx` TABS.

## Notes

- Only docker runs on our nodes today. The cgroup path is runtime-agnostic:
  podman, nspawn or anything else with a root PID slots into the same shape.
- No history table for per-container series yet. If wanted, a
  `container_snapshots` table on the mesh tiered-storage template is a
  follow-up.
