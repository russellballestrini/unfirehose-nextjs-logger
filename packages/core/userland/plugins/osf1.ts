import type { Userland } from '../types';


export const Osf1: Userland = {
  id: 'osf1',
  label: 'Tru64 UNIX',
  sysnames: ['OSF1'],
  notes: 'DEC/Compaq/HP Tru64 on Alpha. vmstat -P for physical memory, psrinfo for CPUs, hwmgr for devices. ps takes BSD flags.',
  body: `
  kv nproc "\`psrinfo 2>/dev/null | wc -l | awk '{print $1}'\`"
  kv cpu "\`psrinfo -v 2>/dev/null | grep -i processor | sed -n 1p | sed 's/^[ 	]*//'\`"
  kv mem_total "\`vmstat -P 2>/dev/null | sed -n 's/^Total Physical Memory *= *//p' | sed 's/(.*//'\`"
  kv pagesize "\`getconf PAGESIZE 2>/dev/null\`"
  kv mem_avail "\`vmstat -P 2>/dev/null | sed -n 's/^ *Free Pages *= *//p' | awk '{print $1 " pages"}'\`"
  kv swap_raw "\`swapon -s 2>/dev/null | grep -i -e 'Allocated space' -e 'Available space' | tr '\\n' ' '\`"
  hwmgr -view devices 2>/dev/null | grep -i disk | awk '{print "DISK", $NF, "?"}'

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
