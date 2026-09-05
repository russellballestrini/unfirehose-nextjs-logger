import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { parseProbeOutput } from '@/lib/node-probe';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Deep probe a single mesh node — returns ps aux, GPU info, CPU details,
 * disk usage, network interfaces, temperatures, and per-process resource usage.
 *
 * GET /api/mesh/node?host=localhost
 * GET /api/mesh/node?host=cammy.foxhop.net
 */

const PROBE_SCRIPT = `
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
head -30 /proc/cpuinfo 2>/dev/null || echo 'n/a'

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
nproc 2>/dev/null || echo '0'

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
\$T df -h --output=source,size,used,avail,pcent,target 2>/dev/null | grep -E '^(/dev|tmpfs)' || echo 'n/a'

# --- processes (top CPU consumers) ---
echo '===SECTION:PS==='
ps aux --sort=-%cpu 2>/dev/null | grep -v '===SECTION:' | head -50 || echo 'n/a'

# --- claude processes specifically ---
# Every agent harness, not just claude. uncloseai-cli is a Python console
# script and appears as "python3 .../unclose", so its basename is python3 —
# matching column 11 alone reported 0 while 5 agents were running. The rule
# (basename, then script name when the basename is an interpreter) lives in
# @unturf/unfirehose/harness-procs; we ship the whole table and apply it
# server-side so adding a harness never means editing an embedded shell string.
echo '===SECTION:CLAUDE_PS==='
ps aux 2>/dev/null | grep -v '===SECTION:' || echo 'none'

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
echo '===SECTION:DOCKER==='
\$T docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | head -20 || echo 'none'

# --- tmux sessions ---
echo '===SECTION:TMUX==='
\$T tmux list-sessions 2>/dev/null || echo 'none'

# --- screen sessions ---
echo '===SECTION:SCREEN==='
\$T screen -ls 2>/dev/null | grep -E '^\s+\d+' || echo 'none'

echo '===SECTION:END==='
`.trim();


function probeLocal(): string {
  try {
    return execSync(`bash -c '${PROBE_SCRIPT.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 15000,
    });
  } catch (e: any) {
    return e.stdout ?? '';
  }
}

function probeRemote(host: string): string {
  try {
    return execSync(
      `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'bash -s' << 'PROBE_EOF'\n${PROBE_SCRIPT}\nPROBE_EOF`,
      { encoding: 'utf-8', timeout: 20000, shell: '/bin/bash' }
    );
  } catch (e: any) {
    return e.stdout ?? '';
  }
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
    try {
      const localHostname = execSync('hostname', { encoding: 'utf-8' }).trim();
      const localFqdn = execSync('hostname -f 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim();
      isLocal = host === localHostname || host === localFqdn;
    } catch { /* ignore */ }
  }

  const raw = isLocal ? probeLocal() : probeRemote(host);

  if (!raw.includes('===SECTION:HOSTNAME===')) {
    return NextResponse.json({
      hostname: host,
      reachable: false,
      error: 'Probe failed — host unreachable or timed out',
      probedAt: new Date().toISOString(),
    });
  }

  return NextResponse.json(parseProbeOutput(raw, host));
}
