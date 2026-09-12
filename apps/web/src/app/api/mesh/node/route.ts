import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { parseProbeOutput } from '@/lib/node-probe';
import { buildProbeScript } from '@unturf/unfirehose/userland';
import { probeRemoteWire } from '@unturf/unfirehose/mesh-remote';


/**
 * Deep probe a single mesh node — returns ps aux, GPU info, CPU details,
 * disk usage, network interfaces, temperatures, and per-process resource usage.
 *
 * GET /api/mesh/node?host=localhost
 * GET /api/mesh/node?host=cammy.foxhop.net
 */

const PROBE_SCRIPT = `
# --- a 1979 Bourne shell can run this far: hand the rest to a POSIX one ---
# Solaris 10 and IRIX ship that shell as /bin/sh, and it has no $( ), which
# everything below the userland section uses. It reads a pipe one byte at
# a time, so the shell exec'd here picks up at exactly the next line. A
# POSIX shell must NOT do this — dash reads ahead and the handoff lands
# mid-buffer — and the tell is that old Bourne does not expand ~.
if [ -z "$UF_POSIX" ] && [ -n "$HOME" ] && [ "\`echo ~\`" = '~' ]; then
  UF_POSIX=1; export UF_POSIX
  for s in /usr/xpg4/bin/sh /usr/bin/ksh93 /usr/bin/ksh /bin/ksh /usr/local/bin/bash /bin/bash /usr/bin/bash; do
    if [ -x "$s" ]; then exec "$s" -s; fi
  done
fi

# --- the userland probe: what the mesh card reads, for every OS ---
# The sections after it are what Linux can add. On a BSD, a Solaris or a
# Mac most of them come back n/a and the page fills its basics from here.
echo '===SECTION:UF==='
${buildProbeScript()}

# Any command below that touches a filesystem or a device can block forever,
# and a blocked command does not fail — it hangs until our execSync timeout
# kills SSH, truncating every section after it. A single wedged FUSE mount on
# one node (a dead keybase-redirector, a stale NFS export) silently blanked
# that node's disk, sensors, topology and network. Bound the ones that can
# block so a stuck subsystem costs us that subsystem, not the whole probe.
T=''
command -v timeout >/dev/null 2>&1 && T='timeout 8'

# --- hostname ---
echo '===SECTION:HOSTNAME==='
hostname

# --- cpu info ---
echo '===SECTION:CPUINFO==='
# aarch64 boards name themselves in Model/Hardware lines AFTER every core's
# block, which head -30 never reaches on a 4-core Pi.
{ head -30 /proc/cpuinfo; grep -E '^(Model|Hardware|CPU implementer|CPU part)\s*:' /proc/cpuinfo | head -4; } 2>/dev/null || echo 'n/a'

# --- cpu arch ---
echo '===SECTION:ARCH==='
uname -m 2>/dev/null || echo 'n/a'

# --- kernel ---
echo '===SECTION:KERNEL==='
uname -r 2>/dev/null || echo 'n/a'

# --- os ---
echo '===SECTION:OS==='
cat /etc/os-release 2>/dev/null | head -5 || echo 'n/a'

# --- nproc ---
echo '===SECTION:NPROC==='
nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo '0'

# --- meminfo ---
echo '===SECTION:MEMINFO==='
cat /proc/meminfo 2>/dev/null || echo 'n/a'

# --- loadavg ---
echo '===SECTION:LOADAVG==='
cat /proc/loadavg 2>/dev/null || echo '0 0 0 0/0 0'

# --- uptime ---
echo '===SECTION:UPTIME==='
cat /proc/uptime 2>/dev/null || echo '0 0'

# --- disk ---
echo '===SECTION:DISK==='
# GNU df has --output; everyone else's -k prints the same six columns in
# kilobytes, which parseDisk renders.
\$T df -h --output=source,size,used,avail,pcent,target 2>/dev/null | grep -E '^(/dev|tmpfs)' || \$T df -k 2>/dev/null | grep -E '^/' || echo 'n/a'

# --- processes (top CPU consumers) ---
echo '===SECTION:PS==='
# --sort is procps; a BSD ps sorts in the pipe, and a System V ps has no aux.
{ ps aux --sort=-%cpu 2>/dev/null || { ps aux 2>/dev/null | sed -n 1p; ps aux 2>/dev/null | sed 1d | sort -k3 -rn; } || ps -eo user,pid,pcpu,pmem,vsz,rss,tty,s,stime,time,args 2>/dev/null; } | grep -v '===SECTION:' | head -50 || echo 'n/a'

# --- process tree (ps -ejH: job hierarchy, session/group ids) ---
# Our Processes tab shows this by default. The CPU-sorted list above answers
# "what is hot"; this answers "who spawned what" — which tmux server owns
# which shell owns which agent. Full table, no head: a truncated tree lies
# about parentage.
echo '===SECTION:PS_TREE==='
# -ejH is procps; the POSIX -eo form has the same columns without the tree.
{ ps -ejH 2>/dev/null || ps -eo pid,pgid,sid,tty,time,comm 2>/dev/null; } | grep -v '===SECTION:' || echo 'n/a'

# --- claude processes specifically ---
# Every agent harness, not just claude. uncloseai-cli is a Python console
# script and appears as "python3 .../unclose", so its basename is python3 —
# matching column 11 alone reported 0 while 5 agents were running. The rule
# (basename, then script name when the basename is an interpreter) lives in
# @unturf/unfirehose/harness-procs; we ship the whole table and apply it
# server-side so adding a harness never means editing an embedded shell string.
echo '===SECTION:CLAUDE_PS==='
{ ps aux 2>/dev/null || ps -eo user,pid,pcpu,pmem,vsz,rss,tty,s,stime,time,args 2>/dev/null; } | grep -v '===SECTION:' || echo 'none'

# --- GPU nvidia ---
echo '===SECTION:NVIDIA==='
\$T nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,power.draw,power.limit,fan.speed,pstate --format=csv,noheader,nounits 2>/dev/null || echo 'none'

# --- GPU nvidia clocks + throttle reasons ---
# Deliberately a SECOND query rather than extra columns on the one above.
# clocks_throttle_reasons.active is not supported on every driver, and an
# unsupported field fails the WHOLE query — folding it in would blank our
# entire GPU panel on older boxes to gain one field.
echo '===SECTION:NVIDIA_CLOCKS==='
\$T nvidia-smi --query-gpu=index,clocks.current.graphics,clocks.max.graphics,clocks_throttle_reasons.active --format=csv,noheader,nounits 2>/dev/null || echo 'none'

# --- GPU nvidia processes ---
echo '===SECTION:NVIDIA_PS==='
\$T nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || echo 'none'

# --- GPU AMD ---
echo '===SECTION:AMD_GPU==='
\$T rocm-smi --showtemp --showuse --showmemuse --showpower --showfan --csv 2>/dev/null || echo 'none'

# --- temperatures (ACPI thermal zones) ---
# Emitted as type|millidegrees pairs on one line each. The old shape printed
# every temp then every type as two separate runs and rejoined them by index,
# which silently mispaired the moment one cat returned fewer lines than the
# other (a zone can vanish between the two globs).
echo '===SECTION:TEMPS==='
for z in /sys/class/thermal/thermal_zone*; do
  [ -d "\$z" ] || continue
  echo "\$(cat "\$z/type" 2>/dev/null)|\$(cat "\$z/temp" 2>/dev/null)"
done

# --- hwmon sensors (temps + fans, with per-sensor limits) ---
# hwmon is strictly richer than thermal_zone: it carries chip names, human
# labels (Core 0, Composite), fan RPM, and each sensor's own crit/max. We
# grade against those limits rather than a hardcoded threshold — 87C on a
# chip that crits at 100 is not the same story as 87C on an unbounded
# chassis zone.
# The hwmon instance is carried because a dual-socket box exposes ONE
# coretemp chip PER SOCKET, each publishing its own Core 0..N. Chip name
# plus sensor key is identical across them, so without the instance the two
# sockets' cores are indistinguishable and collide.
# Emits chip|instance|key|label|value|crit|max|pwm.
echo '===SECTION:HWMON==='
for d in /sys/class/hwmon/hwmon*; do
  [ -d "\$d" ] || continue
  n=\$(cat "\$d/name" 2>/dev/null)
  [ -n "\$n" ] || n=hwmon
  inst=\$(basename "\$d")
  for f in "\$d"/temp*_input "\$d"/fan*_input; do
    [ -e "\$f" ] || continue
    b=\${f%_input}
    k=\$(basename "\$b")
    v=\$(cat "\$f" 2>/dev/null)
    [ -n "\$v" ] || continue
    p=''
    case "\$k" in fan*) p=\$(cat "\$d/pwm\${k#fan}" 2>/dev/null) ;; esac
    echo "\$n|\$inst|\$k|\$(cat "\${b}_label" 2>/dev/null)|\$v|\$(cat "\${b}_crit" 2>/dev/null)|\$(cat "\${b}_max" 2>/dev/null)|\$p"
  done
done

# --- thermal throttling + clock ---
# The counters are the ground truth for "did this box actually throttle".
# Temperature says how hot; these say what the hot cost us. A rising
# package_throttle_count with the clock parked below cpuinfo_max_freq is
# exactly the state a human feels as a stuttering mouse and glitching audio.
echo '===SECTION:THROTTLE==='
echo "pkg_count|\$(cat /sys/devices/system/cpu/cpu*/thermal_throttle/package_throttle_count 2>/dev/null | sort -n | tail -1)"
echo "core_count|\$(cat /sys/devices/system/cpu/cpu*/thermal_throttle/core_throttle_count 2>/dev/null | sort -n | tail -1)"
echo "pkg_ms|\$(cat /sys/devices/system/cpu/cpu*/thermal_throttle/package_throttle_total_time_ms 2>/dev/null | sort -n | tail -1)"
echo "cur_khz|\$(cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq 2>/dev/null | awk '{s+=\$1;n++} END{if(n)print int(s/n)}')"
echo "max_khz|\$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null)"
echo "min_khz|\$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq 2>/dev/null)"

# --- cpu topology (for physical core layout) ---
# core_id + package + die place a core on our chip. Cache sharing is what
# reveals a cluster, and WHICH level does it is vendor-specific: Intel
# hybrid parts put four E-cores behind one shared L2, while AMD keeps L2
# private and clusters at L3 (a CCX). So we read cache level explicitly
# rather than assuming index2 is L2 — that assumption holds on x86 but not
# everywhere, and picks the wrong level on AMD regardless.
# Max frequency separates core types without guessing from a model name.
# Emits cpu|core_id|pkg|die|l2_shared|l3_shared|max_khz.
echo '===SECTION:CPUTOPO==='
for c in /sys/devices/system/cpu/cpu[0-9]*; do
  [ -d "\$c/topology" ] || continue
  n=\$(basename "\$c")
  l2=''; l3=''
  for ci in "\$c"/cache/index*; do
    [ -d "\$ci" ] || continue
    case "\$(cat "\$ci/level" 2>/dev/null)" in
      2) l2=\$(cat "\$ci/shared_cpu_list" 2>/dev/null) ;;
      3) l3=\$(cat "\$ci/shared_cpu_list" 2>/dev/null) ;;
    esac
  done
  echo "\${n#cpu}|\$(cat "\$c/topology/core_id" 2>/dev/null)|\$(cat "\$c/topology/physical_package_id" 2>/dev/null)|\$(cat "\$c/topology/die_id" 2>/dev/null)|\$l2|\$l3|\$(cat "\$c/cpufreq/cpuinfo_max_freq" 2>/dev/null)"
done

# --- network interfaces ---
echo '===SECTION:NET==='
ip -brief addr 2>/dev/null | head -20 || ifconfig 2>/dev/null | head -40 || echo 'n/a'

# --- network throughput snapshot ---
echo '===SECTION:NETSTAT==='
cat /proc/net/dev 2>/dev/null | tail -n +3 || echo 'n/a'

# --- io stats ---
echo '===SECTION:IOSTAT==='
cat /proc/diskstats 2>/dev/null | head -20 || echo 'n/a'

# --- docker/containers ---
# Every container, stopped ones included: a node whose ten containers are
# all exited read as having none, and "running" is what the Status column says.
echo '===SECTION:DOCKER==='
\$T docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | head -50 || echo 'none'

# --- tmux sessions ---
echo '===SECTION:TMUX==='
\$T tmux list-sessions 2>/dev/null || echo 'none'

# --- screen sessions ---
echo '===SECTION:SCREEN==='
\$T screen -ls 2>/dev/null | grep -E '^\s+\d+' || echo 'none'

echo '===SECTION:END==='
`.trim();


/**
 * Run a command off the event loop.
 *
 * This route used execSync. The probe is a shell script that takes 4 to 10
 * seconds on a loaded node, and for that whole time the process that answers
 * every request answered nothing — the node page polls it every six seconds,
 * so with that page open the server was frozen for most of every interval
 * and every other page felt it. Measured 2026-09-06: a 25ms endpoint took
 * 10.9s, 5.7s, 5.2s while one probe ran.
 *
 * A killed command (timeout) still yields what it wrote, as execSync's
 * e.stdout did; the parser flags the truncation.
 */
function run(cmd: string, opts: { timeout: number; shell?: string }): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout) => {
      resolve(typeof stdout === 'string' ? stdout : '');
      void err;
    });
  });
}

function probeLocal(): Promise<string> {
  // UF_POSIX set: the script is an argument here, not stdin, so its
  // re-exec-a-POSIX-shell preamble must not fire (it would read nothing).
  return run(`UF_POSIX=1 bash -c '${PROBE_SCRIPT.replace(/'/g, "'\\''")}'`, { timeout: 15000 });
}

function probeRemote(host: string): Promise<string> {
  // `sh`, not `bash`: a BSD, a Solaris or an AIX has no bash to hand the
  // script to, and the script's own first lines find a POSIX shell.
  return run(
    `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes ${host} sh << 'PROBE_EOF'\n${PROBE_SCRIPT}\nPROBE_EOF`,
    { timeout: 25000, shell: '/bin/bash' },
  );
}

/** Our own names, or null when the machine cannot say — then nothing is local. */
async function ownNames(): Promise<{ short: string; fqdn: string } | null> {
  return new Promise((resolve) => {
    exec('hostname', { encoding: 'utf-8' }, (err, short) => {
      if (err) return resolve(null);
      exec('hostname -f 2>/dev/null || echo ""', { encoding: 'utf-8' }, (err2, fqdn) => {
        if (err2) return resolve(null);
        resolve({ short: String(short).trim(), fqdn: String(fqdn).trim() });
      });
    });
  });
}

export async function GET(req: NextRequest) {
  const host = req.nextUrl.searchParams.get('host');
  if (!host) {
    return NextResponse.json({ error: 'Missing host parameter' }, { status: 400 });
  }

  // Sanitize host to prevent command injection
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) {
    return NextResponse.json({ error: 'Invalid host' }, { status: 400 });
  }

  // Detect if the requested host is actually localhost
  let isLocal = host === 'localhost';
  if (!isLocal) {
    const names = await ownNames();
    isLocal = !!names && (host === names.short || host === names.fqdn);
  }

  let raw = isLocal ? await probeLocal() : await probeRemote(host);

  // No sh on the far side — Windows, network gear. The mesh card already
  // reaches those through core's speaker chain (PowerShell, cmd, a network
  // OS's own command line); ask it for the wire and wrap it as our
  // userland section, so this page gets what the card gets.
  let chainError: string | undefined;
  if (!isLocal && !raw.includes('===SECTION:HOSTNAME===')) {
    const a = await probeRemoteWire(host);
    if (a.wire !== null) {
      const name = a.wire.match(/^hostname=(.*)$/m)?.[1]?.trim() || host;
      raw = `===SECTION:UF===\n${a.wire}\n===SECTION:HOSTNAME===\n${name}\n===SECTION:END===\n`;
    } else {
      chainError = a.error;
    }
  }

  if (!raw.includes('===SECTION:HOSTNAME===')) {
    return NextResponse.json({
      hostname: host,
      reachable: false,
      error: chainError ? `Probe failed — ${chainError}` : 'Probe failed — host unreachable or timed out',
      probedAt: new Date().toISOString(),
    });
  }

  return NextResponse.json(parseProbeOutput(raw, host));
}
