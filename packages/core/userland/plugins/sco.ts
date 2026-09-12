import type { Userland } from '../types';


export const Sco: Userland = {
  id: 'sco',
  label: 'SCO OpenServer / UnixWare',
  sysnames: ['UnixWare', 'SCO_SV'],
  notes: 'uname -X prints NumCPU on both; psrinfo exists on UnixWare; memsize on OpenServer; disks are /dev/rdsk/c?b?t?d?s?.',
  body: `
  kv nproc "\`uname -X 2>/dev/null | sed -n 's/^NumCPU *= *//p'\`"
  kv cpu "\`psrinfo -v 2>/dev/null | grep -i -e processor -e operates | sed -n 1p | sed 's/^[ 	]*//'\`"
  kv mem_total "\`memsize 2>/dev/null\` B"
  kv mem_avail "\`sar -r 1 1 2>/dev/null | tail -1 | awk '{print $2 " pages"}'\`"
  kv pagesize "\`getconf PAGESIZE 2>/dev/null\`"
  kv swap_raw "\`swap -s 2>/dev/null\`"
  ls /dev/rdsk 2>/dev/null | sed 's/s[0-9]*$//' | sort -u | awk '{print "DISK", $1, "1"}'

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
