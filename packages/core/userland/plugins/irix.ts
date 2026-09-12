import type { Userland } from '../types';


export const Irix: Userland = {
  id: 'irix',
  label: 'IRIX',
  sysnames: ['IRIX', 'IRIX64'],
  notes: 'SGI IRIX 6.x. hinv is the hardware inventory; sar -r has freemem in pages. Disks of the era spin.',
  body: `
  kv nproc "\`hinv -c processor 2>/dev/null | sed -n 's/^\\([0-9][0-9]*\\) .*[Pp]rocessor.*/\\1/p' | sed -n 1p\`"
  [ -z "\`hinv -c processor 2>/dev/null\`" ] && kv nproc "\`sysconf NPROC_ONLN 2>/dev/null\`"
  kv cpu "\`hinv -c processor 2>/dev/null | grep -i 'CPU:' | sed -n 1p | sed 's/^CPU: *//'\`"
  kv mem_total "\`hinv -c memory 2>/dev/null | sed -n 's/^Main memory size: *//p'\`"
  kv pagesize "\`getconf PAGESIZE 2>/dev/null || sysconf PAGESIZE 2>/dev/null\`"
  kv mem_avail "\`sar -r 1 1 2>/dev/null | tail -1 | awk '{print $2 " pages"}'\`"
  kv swap_raw "\`swap -s 2>/dev/null\`"
  hinv -c disk 2>/dev/null | grep -i 'disk drive' | awk '{print "DISK dks" NR, "1"}'

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
