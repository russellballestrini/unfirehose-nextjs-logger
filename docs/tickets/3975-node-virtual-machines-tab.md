# 3975: Virtual Machines view on our node page

**Status:** open
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
