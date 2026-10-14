# 3975: Virtual Machines view on our node page

**Status:** shipped (2026-10-14) — a Virtual Machines section inside our Containers tab, not a tab of its own
**Project:** unfirehose-nextjs-logger
**Estimated:** 90m
**Todo IDs:** 3975

## Context

fox asked (2026-09-14) to also see LXC/LXD, QEMU/KVM, Xen and VirtualBox on
our node page. Two families:

- **Containers** (LXC/LXD, systemd-nspawn) — cgroup-based, same as docker.
  DONE: folded into our Containers tab via the generalized cgroup scan
  (commit 0c84559). Each carries a runtime badge. cammy's ~389 LXD guests
  and guile/blanka's nspawn machines now show with cpu/mem/tasks.
- **Virtual machines** (QEMU/KVM, Xen, VirtualBox) — host processes, not
  cgroup containers. Still TODO: a dedicated view.

## Mesh survey (2026-09-14)

| node | qemu | vbox | xen | lxc | nspawn | virsh |
|------|------|------|-----|-----|--------|-------|
| cammy | 0 | 0 | no | 389 | 0 | yes |
| guile | 2 | 0 | no | 0 | 74 | yes |
| 3090-ai | 0 | 0 | no | 0 | 0 | - |
| 4090-ai | 0 | 0 | no | 68 | 0 | - |
| blanka | 0 | 0 | no | 0 | 64 | yes |

Only guile runs real VMs (2 qemu). They already appear under Containers via
machined's `machine-qemu\x2d...` scopes (cgroup cpu/mem), but without the
VM-specific facts (configured memory, vcpus, disk images, guest name).

## Plan

Probe VM host processes and surface them, host-side (no guest agents):

- **QEMU/KVM**: parse `qemu-system-*` argv — `-name guest=<n>` / `-name <n>`,
  `-m <MB>` (memory), `-smp <n>` (vcpus), `-uuid`. Host cpu%/rss from ps.
- **Xen**: `xl list` (name, mem, vcpus, state) when `xl` present; dom0 aside.
- **VirtualBox**: `VBoxManage list runningvms` + `VBoxHeadless --startvm` argv.
- **libvirt**: `virsh list --all` for names/state as a cross-check.

Add a `Virtual Machines` tab (shown only when a node runs any): per-VM name,
hypervisor type, state, configured memory, vcpus, host cpu%/rss, and a link
to the guest's machined cgroup stats where one exists.

Guest-internal metrics (load, disk, processes inside) need a guest agent —
out of scope; this is the host's view of its guests.

## Notes

- Parser + probe section mirror the container work (parseVmProcesses, a VM
  section in route.ts). Tests per parser.
- No Xen/VBox on the mesh today; implement detection but expect it dark.

## Shipped (2026-10-14)

- Probe: a `VMS` section in `apps/web/src/app/api/mesh/node/route.ts`. One
  `ps -eo` pass for `qemu-system-*`, `qemu-kvm` and `VBoxHeadless` processes
  (`proc|pid pcpu pmem rss etimes argv`), then `virsh -r -c qemu:///system
  list --all` (falling back to the default URI), `xl list`, `VBoxManage list
  runningvms` / `list vms`, each line tagged by tool. Read-only, bounded by
  `$T`, `none` when nothing answers.
- Parser: `parseVms`, `parseQemuArgv`, `parseQemuMemMB`, `parseQemuSmp`,
  `parseVirshList`, `parseXlList`, `parseVboxList`, `linkVmContainers` in
  `apps/web/src/lib/node-probe.ts`; `parseProbeOutput` now returns `vms`.
  Rows merge by guest name within a hypervisor family; a libvirt guest is
  tied to its machined `qemu-<id>-<name>` scope in the container list, which
  carries the kernel's cpu/mem/tasks for it.
- UI: `VirtualMachinesSection` in `[node]/tabs.tsx`, rendered at the top of
  the Containers tab when a host has any guest (also on a host with guests
  and no containers). Tiles: guests by state, configured vCPUs and memory,
  host CPU and RSS of the hypervisor processes. Table: guest, hypervisor
  and kvm/tcg badge, state in the tool's words, vCPUs, memory, host CPU,
  host RSS, disk images, pid/uuid/uptime/sources, and a `cgroup ↓` link to
  the machined row below. Chosen over a conditional tab: the machined scope
  already put the guest in this tab, and a tab that appears only on two
  hosts would shift the strip around.
- Tests: parsers in `node-probe.test.ts` (libvirt 9 argv, hand-run argv,
  tcg, every `-m`/`-smp` spelling, padded and single-spaced virsh, xl with
  Domain-0, VBoxManage, merge, container link, parseProbeOutput carrying
  `vms`); rendering in `tabs.test.tsx`.

**Fixture note.** On 2026-10-14 no guest was running anywhere on our mesh:
guile's libvirt qemu daemon socket (`virtqemud-sock`) was absent, no
`qemu-system-*` process existed, and `virsh` could not connect. The three
domains still exist under `/var/lib/libvirt/qemu/` (`domain-38-11_buildunturfcom`,
`domain-37-6_akuma2204`, `domain-13-10_lab11`), so test fixtures use the
documented libvirt 9 / virsh 9 / xl / VBoxManage shapes carrying those real
guest names. End-to-end was verified on localhost with a stand-in process
whose argv mimicked qemu. The survey table above is from 2026-09-14 and is
stale on the qemu and nspawn columns for guile.

Out of scope, as planned: guest-internal metrics (need an agent), an
Overview-tab summary line for guests.
