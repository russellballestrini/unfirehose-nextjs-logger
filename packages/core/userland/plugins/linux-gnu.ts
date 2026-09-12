import type { Userland } from '../types';


export const LinuxGnu: Userland = {
  id: 'linux-gnu',
  label: 'GNU/Linux',
  sysnames: ['Linux'],
  notes: 'The reference: procps ps, coreutils, sysfs. Every other plugin is measured against what this one reports.',
  body: `
  kv nproc "\`nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null\`"

  # /proc, as Linux, Hurd and Cygwin all present it.
  c=\`sed -n '/^model name/{p;q;}' /proc/cpuinfo 2>/dev/null\`
  [ -z "$c" ] && c=\`sed -n '/^cpu model/{p;q;}' /proc/cpuinfo 2>/dev/null\`
  [ -z "$c" ] && c=\`sed -n '/^Model/{p;q;}' /proc/cpuinfo 2>/dev/null\`
  [ -z "$c" ] && c=\`sed -n '/^Hardware/{p;q;}' /proc/cpuinfo 2>/dev/null\`
  [ -z "$c" ] && c=\`sed -n '/^cpu[ 	]*:/{p;q;}' /proc/cpuinfo 2>/dev/null\`
  [ -z "$c" ] && c=\`{ grep '^CPU implementer' /proc/cpuinfo; grep '^CPU part' /proc/cpuinfo; } 2>/dev/null | sed -n '1,2p' | tr '\\n' ' '\`
  kv cpu "$c"
  kv mem_total "\`sed -n 's/^MemTotal:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv mem_avail "\`sed -n 's/^MemAvailable:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv mem_free "\`sed -n 's/^MemFree:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv mem_buffers "\`sed -n 's/^Buffers:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv mem_cached "\`sed -n 's/^Cached:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv swap_total "\`sed -n 's/^SwapTotal:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv swap_free "\`sed -n 's/^SwapFree:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv load "\`first /proc/loadavg\`"
  kv uptime_s "\`first /proc/uptime | cut -d' ' -f1\`"

  # Whole devices only live in /sys/block; a partition never does. A block
  # device without a \`device\` link is virtual (md, dm, zram, loop).
  if [ -d /sys/block ]; then
    for b in /sys/block/*; do
      n=\`basename "$b"\`
      case "$n" in loop*|ram*|zram*|dm-*|md*|sr*|fd*|nbd*|rbd*|drbd*|zd*) continue;; esac
      if [ -e "$b/device" ]; then
        r=\`cat "$b/queue/rotational" 2>/dev/null\`
        [ -z "$r" ] && r='?'
        echo "DISK $n $r"
      fi
    done
  elif have lsblk; then
    lsblk -d -n -o NAME,TYPE,ROTA 2>/dev/null | awk '$2=="disk" {print "DISK", $1, $3}'
  elif [ -r /proc/partitions ]; then
    # 2.4 kernels: no sysfs. Whole disks are the names that do not end in a digit.
    awk 'NR>2 && $4 !~ /[0-9]$/ && $4 !~ /^(loop|ram|md)/ {print "DISK", $4, "?"}' /proc/partitions 2>/dev/null
  fi

  ps aux 2>/dev/null | hprocs

  # Intel RAPL: two energy readings a known interval apart. Old sleep
  # cannot do fractions; report which interval we actually got.
  e0=/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj
  e1=/sys/class/powercap/intel-rapl/intel-rapl:1/energy_uj
  if [ -r "$e0" ]; then
    r1=\`cat "$e0" 2>/dev/null\`; r1b=\`cat "$e1" 2>/dev/null\`
    if sleep 0.1 2>/dev/null; then dt=0.1; else sleep 1; dt=1; fi
    r2=\`cat "$e0" 2>/dev/null\`; r2b=\`cat "$e1" 2>/dev/null\`
    echo "RAPL $r1 \${r1b:-0} $r2 \${r2b:-0} $dt"
  fi

  nvidia
  if have rocm-smi; then rocm-smi --showpower --showuse --showmemuse --csv 2>/dev/null | sed 's/^/AMDGPU /'; fi`,
};
