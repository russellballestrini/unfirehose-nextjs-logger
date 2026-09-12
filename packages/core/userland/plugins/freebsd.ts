import type { Userland } from '../types';


export const Freebsd: Userland = {
  id: 'freebsd',
  label: 'FreeBSD',
  sysnames: ['FreeBSD', 'MidnightBSD', 'DragonFly', 'GNU/kFreeBSD', 'JUNOS'],
  notes: 'FreeBSD, DragonFly, MidnightBSD, Debian GNU/kFreeBSD, and Junos (a FreeBSD under the CLI, reached via `start shell sh`). sysctl for everything; diskinfo -v reports rotation rate on 12+.',
  body: `
  kv nproc "\`sysctl_n hw.ncpu\`"
  kv cpu "\`sysctl_n hw.model\`"
  kv pagesize "\`sysctl_n hw.pagesize\`"
  kv mem_total "\`sysctl_n hw.physmem\` B"
  kv mem_avail "\`sysctl_n vm.stats.vm.v_free_count\` \`sysctl_n vm.stats.vm.v_inactive_count\` \`sysctl_n vm.stats.vm.v_cache_count\` pages"
  if have swapinfo; then
    swapinfo -k 2>/dev/null | awk 'NR>1 && $1!="Total" {t+=$2; u+=$3} END {print "swap_total=" t " kB"; print "swap_used=" u " kB"}'
  fi
  kv load "\`sysctl_n vm.loadavg\`"
  kv boottime "\`sysctl_n kern.boottime\`"
  for d in \`sysctl_n kern.disks\` \`sysctl_n hw.disknames\`; do
    case "$d" in cd*|acd*|md*|fd*|vn*) continue;; nvd*|nda*|nvme*) echo "DISK $d 0"; continue;; esac
    r=\`diskinfo -v /dev/$d 2>/dev/null | grep -i 'rotation rate' | awk '{print $1}'\`
    case "$r" in 0) echo "DISK $d 0";; ''|[Uu]nknown) echo "DISK $d ?";; *) echo "DISK $d 1";; esac
  done

  if ps aux 2>/dev/null | sed -n 1p | grep '%CPU' >/dev/null 2>&1; then
    ps aux 2>/dev/null | hprocs
  elif ps -eo user,pid,pcpu,pmem,vsz,rss,tty,s,stime,time,args 2>/dev/null | sed -n 1p | grep -i 'pid' >/dev/null 2>&1; then
    ps -eo user,pid,pcpu,pmem,vsz,rss,tty,s,stime,time,args 2>/dev/null | hprocs
  elif ps -eo user,pid,pcpu,pmem,vsz,rss,tty,state,stime,time,args 2>/dev/null | sed -n 1p | grep -i 'pid' >/dev/null 2>&1; then
    ps -eo user,pid,pcpu,pmem,vsz,rss,tty,state,stime,time,args 2>/dev/null | hprocs
  else
    psef | hprocs
  fi

  nvidia`,
};
