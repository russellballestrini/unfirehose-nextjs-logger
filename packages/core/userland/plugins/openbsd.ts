import type { Userland } from '../types';


export const Openbsd: Userland = {
  id: 'openbsd',
  label: 'OpenBSD',
  sysnames: ['OpenBSD'],
  notes: 'hw.physmem64 for >4GB; vm.loadavg is three bare numbers; kern.boottime is an epoch. top -n prints Free: NNNM.',
  body: `
  kv nproc "\`sysctl_n hw.ncpuonline\`"
  [ -z "\`sysctl_n hw.ncpuonline\`" ] && kv nproc "\`sysctl_n hw.ncpu\`"
  kv cpu "\`sysctl_n hw.model\`"
  kv pagesize "\`sysctl_n hw.pagesize\`"
  m=\`sysctl_n hw.physmem64\`; [ -z "$m" ] && m=\`sysctl_n hw.physmem\`
  kv mem_total "$m B"
  kv mem_avail "\`top -n 1 2>/dev/null | sed -n 's/.*Free: *\\([0-9]*[KMG]\\).*/\\1/p' | sed -n 1p\`"
  kv swap_raw "\`swapctl -sk 2>/dev/null\`"
  kv load "\`sysctl_n vm.loadavg\`"
  kv boottime "\`sysctl_n kern.boottime\`"
  for d in \`sysctl_n hw.disknames | tr ',' ' '\`; do
    n=\`echo "$d" | cut -d: -f1\`
    case "$n" in cd*|fd*|vnd*|rd*|'') continue;; esac
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
