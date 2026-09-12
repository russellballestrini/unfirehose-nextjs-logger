import type { Userland } from '../types';


export const Netbsd: Userland = {
  id: 'netbsd',
  label: 'NetBSD',
  sysnames: ['NetBSD', 'Minix'],
  notes: 'NetBSD and MINIX 3.2+ (NetBSD userland). top -b prints "NNNM Free"; hw.disknames is space-separated.',
  body: `
  kv nproc "\`sysctl_n hw.ncpuonline\`"
  [ -z "\`sysctl_n hw.ncpuonline\`" ] && kv nproc "\`sysctl_n hw.ncpu\`"
  kv cpu "\`sysctl_n hw.model\`"
  kv pagesize "\`sysctl_n hw.pagesize\`"
  m=\`sysctl_n hw.physmem64\`; [ -z "$m" ] && m=\`sysctl_n hw.physmem\`
  kv mem_total "$m B"
  kv mem_avail "\`top -b -n 1 2>/dev/null | sed -n 's/.*[ ,]\\([0-9]*[KMG]\\) Free.*/\\1/p' | sed -n 1p\`"
  [ -z "\`top -b -n 1 2>/dev/null | grep Free\`" ] && kv mem_avail "\`vmstat 2>/dev/null | tail -1 | awk '{print $5 " kB"}'\`"
  kv swap_raw "\`swapctl -sk 2>/dev/null\`"
  kv load "\`sysctl_n vm.loadavg\`"
  kv boottime "\`sysctl_n kern.boottime\`"
  for n in \`sysctl_n hw.disknames\`; do
    case "$n" in cd*|fd*|vnd*|md*|dk*|raid*|'') continue;; esac
    echo "DISK $n ?"
  done

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
