import type { Userland } from '../types';


export const GnuHurd: Userland = {
  id: 'gnu-hurd',
  label: 'GNU/Hurd',
  sysnames: ['GNU'],
  notes: 'Debian GNU/Hurd. procfs translator serves cpuinfo, meminfo, loadavg, uptime; Hurd ps understands `aux`.',
  body: `
  kv nproc "\`nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null\`"

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

  for d in /dev/hd? /dev/sd? /dev/wd?; do [ -e "$d" ] && echo "DISK \`basename $d\` ?"; done

  if ps aux 2>/dev/null | sed -n 1p | grep '%CPU' >/dev/null 2>&1; then
    ps aux 2>/dev/null | hprocs
  elif ps -eo user,pid,pcpu,pmem,vsz,rss,tty,s,stime,time,args 2>/dev/null | sed -n 1p | grep -i 'pid' >/dev/null 2>&1; then
    ps -eo user,pid,pcpu,pmem,vsz,rss,tty,s,stime,time,args 2>/dev/null | hprocs
  elif ps -eo user,pid,pcpu,pmem,vsz,rss,tty,state,stime,time,args 2>/dev/null | sed -n 1p | grep -i 'pid' >/dev/null 2>&1; then
    ps -eo user,pid,pcpu,pmem,vsz,rss,tty,state,stime,time,args 2>/dev/null | hprocs
  else
    psef | hprocs
  fi`,
};
