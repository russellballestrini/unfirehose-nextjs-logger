import type { Userland } from '../types';


export const Aix: Userland = {
  id: 'aix',
  label: 'AIX',
  sysnames: ['AIX', 'OS400'],
  notes: 'AIX 5–7 and IBM i PASE. prtconf carries model, cores, memory; vmstat fre is 4K pages; lsps -s is the paging space; ps aux works without the dash.',
  body: `
  kv nproc "\`prtconf 2>/dev/null | sed -n 's/^Number Of Processors: *//p'\`"
  [ -z "\`prtconf 2>/dev/null | grep '^Number Of Processors'\`" ] && kv nproc "\`lsdev -Cc processor 2>/dev/null | grep -c Available\`"
  kv cpu "\`prtconf 2>/dev/null | sed -n 's/^Processor Type: *//p'\` @ \`prtconf 2>/dev/null | sed -n 's/^Processor Clock Speed: *//p'\`"
  kv isa "\`uname -p 2>/dev/null\`"
  kv pagesize "\`pagesize 2>/dev/null\`"
  kv mem_total "\`prtconf 2>/dev/null | sed -n 's/^Memory Size: *//p'\`"
  kv mem_avail "\`vmstat 1 1 2>/dev/null | tail -1 | awk '{print $4 " pages"}'\`"
  kv swap_raw "\`lsps -s 2>/dev/null | tail -1\`"
  lsdev -Cc disk 2>/dev/null | awk '{print "DISK", $1, "?"}'

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
