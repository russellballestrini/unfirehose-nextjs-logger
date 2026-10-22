import { unescapeMachineName } from './node-probe-containers';

// ---------------------------------------------------------------------------
// Virtual machines -- our host's view of its guests
// ---------------------------------------------------------------------------

/**
 * A guest as the host sees it. QEMU/KVM, Xen and VirtualBox guests are host
 * processes, so what is known is what the hypervisor's argv or tool says:
 * the guest's name, how much memory and how many vcpus it was given, which
 * disk images it was handed, and -- while it runs -- what the host process
 * costs. Nothing inside the guest is visible from here; that needs an agent.
 *
 * `hypervisor` is the family (qemu covers KVM-accelerated qemu, `accel` says
 * which); `state` keeps the tool's own words ("running", "shut off",
 * "paused", "powered off") since those are what an operator greps for.
 */
export interface VirtualMachine {
  hypervisor: 'qemu' | 'xen' | 'virtualbox';
  /** kvm | tcg | null -- how qemu runs the guest, when its argv says. */
  accel: 'kvm' | 'tcg' | null;
  name: string;
  state: string;
  /** Host pid of the hypervisor process, while it runs. */
  pid: number | null;
  vcpus: number | null;
  /** Configured guest memory in MiB (what the guest believes it has). */
  memMB: number | null;
  uuid: string | null;
  disks: string[];
  /** Host-side cost of the hypervisor process, from ps, while it runs. */
  cpuPct: number | null;
  memPct: number | null;
  rssKB: number | null;
  uptimeSeconds: number | null;
  /** Which sources saw it: proc, virsh, xl, vbox. Two is corroboration. */
  sources: string[];
  /** The machined cgroup (raw container id) wrapping this guest, when one does. */
  containerId: string | null;
}

const vmInt = (v: string | undefined): number | null => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : null;
};
const vmNum = (v: string | undefined): number | null => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : null;
};

/**
 * qemu's -m takes "4096" (MiB), "size=4194304k", "2G", "4096M", or a
 * "4096,slots=4,maxmem=16G" list where the first field is the base size.
 * libvirt emits size=<n>k. Returns MiB.
 */
export function parseQemuMemMB(v: string | undefined): number | null {
  if (!v) return null;
  let first = v.split(',')[0]!.trim();
  first = first.replace(/^(size|mem)=/i, '');
  const m = first.match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  switch ((m[2] ?? '').toLowerCase()) {
    case 'k': return Math.round(n / 1024);
    case 'g': return Math.round(n * 1024);
    case 't': return Math.round(n * 1024 * 1024);
    default:  return Math.round(n); // bare or M: MiB, qemu's default unit
  }
}

/** qemu's -smp: "4", "4,sockets=4,cores=1,threads=1", or "cpus=4,...". */
export function parseQemuSmp(v: string | undefined): number | null {
  if (!v) return null;
  const fields = v.split(',');
  const cpus = fields.find((f) => /^cpus=/.test(f));
  if (cpus) return vmInt(cpus.split('=')[1]);
  if (/^\d+$/.test(fields[0]!.trim())) return vmInt(fields[0]);
  const maxcpus = fields.find((f) => /^maxcpus=/.test(f));
  return maxcpus ? vmInt(maxcpus.split('=')[1]) : null;
}

/**
 * What a qemu command line says about its guest. libvirt (>= 5) hands qemu
 * `-name guest=<n>,debug-threads=on`, `-m size=<n>k`, `-smp N,sockets=..`,
 * `-accel kvm` and JSON `-blockdev {"driver":"file","filename":"..."}`;
 * a hand-run qemu says `-name <n> -m 2048 -smp 2 -enable-kvm -drive
 * file=...`. Both read here. Disks are every image file named by -drive,
 * -blockdev, -hda..-hdd and -cdrom; the backing-chain format nodes that
 * reference another node by name are not files and are skipped.
 */
export function parseQemuArgv(argv: string): Pick<VirtualMachine, 'name' | 'accel' | 'vcpus' | 'memMB' | 'uuid' | 'disks'> {
  const toks = argv.trim().split(/\s+/);
  let name: string | null = null;
  let accel: VirtualMachine['accel'] = null;
  let vcpus: number | null = null;
  let memMB: number | null = null;
  let uuid: string | null = null;
  const disks: string[] = [];
  const pushDisk = (f: string | undefined) => { if (f && !disks.includes(f)) disks.push(f); };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const next = toks[i + 1];
    switch (t) {
      case '-name': {
        if (!next) break;
        const guest = next.split(',').find((f) => /^guest=/.test(f));
        name = guest ? guest.slice(6) : next.split(',')[0]!;
        i++; break;
      }
      case '-m': memMB = parseQemuMemMB(next); i++; break;
      case '-smp': vcpus = parseQemuSmp(next); i++; break;
      case '-uuid': uuid = next ?? null; i++; break;
      case '-enable-kvm': accel = 'kvm'; break;
      case '-accel': {
        if (next) { if (/^kvm\b/.test(next)) accel = 'kvm'; else if (/^tcg\b/.test(next)) accel = accel ?? 'tcg'; }
        i++; break;
      }
      case '-machine': case '-M': {
        if (next) { const a = next.match(/(?:^|,)accel=([a-z]+)/)?.[1]; if (a === 'kvm') accel = 'kvm'; else if (a === 'tcg') accel = accel ?? 'tcg'; }
        i++; break;
      }
      case '-drive': {
        const file = next?.split(',').find((f) => /^file=/.test(f));
        pushDisk(file?.slice(5));
        i++; break;
      }
      case '-blockdev': {
        // Compact JSON from libvirt; a hand-written one may be key=value.
        if (next) {
          const j = next.match(/"filename"\s*:\s*"([^"]+)"/)?.[1];
          const kv = next.split(',').find((f) => /^filename=/.test(f))?.slice(9);
          pushDisk(j ?? kv);
        }
        i++; break;
      }
      case '-hda': case '-hdb': case '-hdc': case '-hdd': case '-cdrom':
        pushDisk(next); i++; break;
      default: break;
    }
  }
  return { name: name ?? '', accel, vcpus, memMB, uuid, disks };
}

/**
 * A `virsh list --all` table:
 *
 *    Id   Name                State
 *   ------------------------------------
 *    38   11_buildunturfcom   running
 *    -    10_lab11            shut off
 *
 * Columns are padded with 2+ spaces (virsh >= 6); an older virsh single-
 * spaces them, where the state is everything after the name.
 */
export function parseVirshList(lines: string[]): Array<{ id: number | null; name: string; state: string }> {
  const out: Array<{ id: number | null; name: string; state: string }> = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^-+$/.test(line) || /^Id\s+Name\s+State/i.test(line)) continue;
    let parts = line.split(/\s{2,}/);
    if (parts.length < 3) {
      const ws = line.split(/\s+/);
      if (ws.length < 3) continue;
      parts = [ws[0]!, ws[1]!, ws.slice(2).join(' ')];
    }
    const [id, name, state] = parts as [string, string, string];
    out.push({ id: id === '-' ? null : vmInt(id), name, state: state.trim() });
  }
  return out;
}

/**
 * `xl list`: Name ID Mem VCPUs State Time(s). Mem is MiB. State is a flag
 * string -- r running, b blocked (idle, still running), p paused,
 * s shutdown, c crashed, d dying. Domain-0 is the host, not a guest.
 */
export function parseXlList(lines: string[]): Array<{ name: string; id: number | null; memMB: number | null; vcpus: number | null; state: string }> {
  const out: Array<{ name: string; id: number | null; memMB: number | null; vcpus: number | null; state: string }> = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^Name\s+ID\s+Mem/i.test(line)) continue;
    const f = line.split(/\s+/);
    if (f.length < 5 || f[0] === 'Domain-0') continue;
    const flags = f[4] ?? '';
    const state = /c/.test(flags) ? 'crashed' : /d/.test(flags) ? 'dying' : /p/.test(flags) ? 'paused'
      : /s/.test(flags) ? 'shut off' : /[rb]/.test(flags) ? 'running' : 'unknown';
    out.push({ name: f[0]!, id: vmInt(f[1]), memMB: vmInt(f[2]), vcpus: vmInt(f[3]), state });
  }
  return out;
}

/** `VBoxManage list vms`: one `"name" {uuid}` per line. */
export function parseVboxList(lines: string[]): Array<{ name: string; uuid: string | null }> {
  const out: Array<{ name: string; uuid: string | null }> = [];
  for (const raw of lines) {
    const m = raw.trim().match(/^"(.*)"\s+\{([0-9a-fA-F-]+)\}$/);
    if (m) out.push({ name: m[1]!, uuid: m[2] ?? null });
  }
  return out;
}

/**
 * The VMS section: every source's lines, tagged. `proc|` rows are
 * `pid pcpu pmem rss etimes args` for each qemu/VBoxHeadless process and
 * carry the live host-side cost; the tool tables add the guests that are
 * defined but not running, and corroborate the ones that are. Rows are
 * merged by guest name within a hypervisor family. A qemu process whose
 * argv names no guest is kept under "qemu <pid>" rather than dropped.
 */
export function parseVms(raw: string): VirtualMachine[] {
  if (!raw || raw === 'none') return [];
  const procs: string[] = [], virsh: string[] = [], xl: string[] = [], vbox: string[] = [], vboxrun: string[] = [];
  for (const line of raw.split('\n')) {
    const bar = line.indexOf('|');
    if (bar === -1) continue;
    const tag = line.slice(0, bar), body = line.slice(bar + 1);
    if (tag === 'proc') procs.push(body);
    else if (tag === 'virsh') virsh.push(body);
    else if (tag === 'xl') xl.push(body);
    else if (tag === 'vbox') vbox.push(body);
    else if (tag === 'vboxrun') vboxrun.push(body);
  }

  const vms: VirtualMachine[] = [];
  const find = (hv: VirtualMachine['hypervisor'], name: string) => vms.find((v) => v.hypervisor === hv && v.name === name);
  const blank = (hv: VirtualMachine['hypervisor'], name: string, state: string, source: string): VirtualMachine => ({
    hypervisor: hv, accel: null, name, state, pid: null, vcpus: null, memMB: null, uuid: null, disks: [],
    cpuPct: null, memPct: null, rssKB: null, uptimeSeconds: null, sources: [source], containerId: null,
  });

  for (const row of procs) {
    const m = row.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, pcpu, pmem, rss, etimes, args] = m;
    const bin = args!.split(/\s+/)[0]!;
    const live = { pid: vmInt(pid), cpuPct: vmNum(pcpu), memPct: vmNum(pmem), rssKB: vmInt(rss), uptimeSeconds: vmInt(etimes) };
    if (/VBoxHeadless$/.test(bin)) {
      const toks = args!.split(/\s+/);
      const at = toks.findIndex((t) => t === '--startvm' || t === '-s' || t === '--comment' || t === '-c');
      const name = at >= 0 ? (toks[at + 1] ?? '') : '';
      const vm = find('virtualbox', name) ?? blank('virtualbox', name || `VBoxHeadless ${pid}`, 'running', 'proc');
      if (!vm.sources.includes('proc')) vm.sources.push('proc');
      Object.assign(vm, live, { state: 'running' });
      if (!vms.includes(vm)) vms.push(vm);
      continue;
    }
    const a = parseQemuArgv(args!);
    const name = a.name || `qemu ${pid}`;
    const vm = find('qemu', name) ?? blank('qemu', name, 'running', 'proc');
    if (!vm.sources.includes('proc')) vm.sources.push('proc');
    Object.assign(vm, live, { state: 'running', accel: a.accel, vcpus: a.vcpus, memMB: a.memMB, uuid: a.uuid, disks: a.disks });
    if (!vms.includes(vm)) vms.push(vm);
  }

  for (const r of parseVirshList(virsh)) {
    const vm = find('qemu', r.name);
    if (vm) { vm.sources.push('virsh'); vm.state = r.state; }
    else vms.push(blank('qemu', r.name, r.state, 'virsh'));
  }

  for (const r of parseXlList(xl)) {
    const vm = find('xen', r.name) ?? blank('xen', r.name, r.state, 'xl');
    Object.assign(vm, { memMB: r.memMB, vcpus: r.vcpus, state: r.state });
    if (!vm.sources.includes('xl')) vm.sources.push('xl');
    if (!vms.includes(vm)) vms.push(vm);
  }

  const running = new Set(parseVboxList(vboxrun).map((r) => r.name));
  for (const r of parseVboxList(vbox)) {
    const vm = find('virtualbox', r.name) ?? blank('virtualbox', r.name, running.has(r.name) ? 'running' : 'powered off', 'vbox');
    vm.uuid = vm.uuid ?? r.uuid;
    if (vm.sources.includes('proc')) vm.state = 'running';
    else vm.state = running.has(r.name) ? 'running' : 'powered off';
    if (!vm.sources.includes('vbox')) vm.sources.push('vbox');
    if (!vms.includes(vm)) vms.push(vm);
  }

  return vms;
}

/**
 * Tie each guest to the machined cgroup that wraps it, when one does.
 * libvirt registers a running guest with systemd-machined as
 * `qemu-<domid>-<name>`, which the cgroup scan lists as an nspawn container
 * named `machine-qemu\x2d38\x2d11_buildunturfcom.scope`. That container row
 * carries the kernel's cpu/mem/tasks for the guest; the VM row points at it
 * rather than repeating it.
 */
export function linkVmContainers<C extends { id: string; runtime?: string }>(vms: VirtualMachine[], containers: C[]): VirtualMachine[] {
  if (vms.length === 0 || containers.length === 0) return vms;
  const byGuest = new Map<string, string>();
  for (const c of containers) {
    if (c.runtime !== 'nspawn') continue;
    const m = unescapeMachineName(c.id).match(/^qemu-\d+-(.+)$/);
    if (m) byGuest.set(m[1]!, c.id);
  }
  if (byGuest.size === 0) return vms;
  return vms.map((v) => v.hypervisor === 'qemu' && byGuest.has(v.name) ? { ...v, containerId: byGuest.get(v.name)! } : v);
}
