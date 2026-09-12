import type { Userland } from '../types';


export const LinuxAndroid: Userland = {
  id: 'linux-android',
  label: 'Android (toybox / Termux)',
  sysnames: ['Linux'],
  refine: `[ "$O" = Android ] || [ -r /system/build.prop ] || have toybox || have getprop`,
  notes: 'Termux sshd or adb. toybox ps takes -o with %CPU/%MEM; older Android ps prints USER PID PPID VSIZE RSS WCHAN PC NAME.',
  body: `
  kv nproc "\`nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null\`"

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

  if have getprop; then
    kv model "\`getprop ro.product.model 2>/dev/null\`"
    kv soc "\`getprop ro.soc.model 2>/dev/null || getprop ro.hardware.chipname 2>/dev/null || getprop ro.board.platform 2>/dev/null\`"
    kv osrel "Android \`getprop ro.build.version.release 2>/dev/null\` (\`uname -r 2>/dev/null\`)"
  fi

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

  if ps -A -o user,pid,%cpu,%mem,vsz,rss,tty,stat,stime,time,args 2>/dev/null | sed -n 1p | grep -i pid >/dev/null 2>&1; then
    ps -A -o user,pid,%cpu,%mem,vsz,rss,tty,stat,stime,time,args 2>/dev/null | hprocs
  elif ps aux 2>/dev/null | sed -n 1p | grep '%CPU' >/dev/null 2>&1; then
    ps aux 2>/dev/null | hprocs
  else
    ps 2>/dev/null | awk 'NR>1 && NF>=9 { printf "%s %s 0.0 0.0 %s %s ? S - 0:00 %s\\n", $1, $2, $4, $5, $NF }' | hprocs
  fi`,
};
