import type { Userland } from '../types';


export const Generic: Userland = {
  id: 'generic',
  label: 'Generic POSIX',
  sysnames: ['*'],
  notes: 'Interix, z/OS USS, NonStop OSS, SINIX, ReliantUNIX, ULTRIX, A/UX, UNICOS, SerenityOS, Redox, and whatever comes next. Asks only what POSIX promises, then tries sysctl and /proc in case they are there.',
  body: `
  kv nproc "\`getconf _NPROCESSORS_ONLN 2>/dev/null || getconf NPROCESSORS_ONLN 2>/dev/null || sysconf NPROC_ONLN 2>/dev/null\`"
  kv cpu "\`uname -p 2>/dev/null\`"
  kv pagesize "\`getconf PAGESIZE 2>/dev/null || getconf PAGE_SIZE 2>/dev/null\`"
  if have sysctl; then
    [ -n "\`sysctl_n hw.model\`" ] && kv cpu "\`sysctl_n hw.model\`"
    [ -n "\`sysctl_n hw.ncpu\`" ] && kv nproc "\`sysctl_n hw.ncpu\`"
    [ -n "\`sysctl_n hw.physmem\`" ] && kv mem_total "\`sysctl_n hw.physmem\` B"
    [ -n "\`sysctl_n vm.loadavg\`" ] && kv load "\`sysctl_n vm.loadavg\`"
    [ -n "\`sysctl_n kern.boottime\`" ] && kv boottime "\`sysctl_n kern.boottime\`"
  fi
  if [ -r /proc/meminfo ]; then

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

  fi

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
