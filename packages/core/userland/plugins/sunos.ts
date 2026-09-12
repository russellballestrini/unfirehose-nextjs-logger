import type { Userland } from '../types';


export const Sunos: Userland = {
  id: 'sunos',
  label: 'Solaris / illumos',
  sysnames: ['SunOS'],
  notes: 'Solaris 8–11, OpenIndiana, SmartOS, OmniOS. /usr/xpg4/bin first on PATH gives POSIX ps/awk. kstat is the truth for memory and boot time; illumos diskinfo -H says SSD yes/no.',
  body: `
  kv nproc "\`psrinfo 2>/dev/null | wc -l | awk '{print $1}'\`"
  c=\`kstat -p cpu_info:0:cpu_info0:brand 2>/dev/null | cut -f2\`
  [ -z "$c" ] && c=\`psrinfo -pv 2>/dev/null | sed -n '$p' | sed 's/^[ 	]*//'\`
  kv cpu "$c"
  kv isa "\`isainfo -k 2>/dev/null || uname -p 2>/dev/null\`"
  kv pagesize "\`pagesize 2>/dev/null\`"
  kv mem_total "\`prtconf 2>/dev/null | sed -n 's/^Memory size: *//p'\`"
  kv mem_avail "\`kstat -p unix:0:system_pages:freemem 2>/dev/null | cut -f2\` pages"
  kv swap_raw "\`swap -s 2>/dev/null\`"
  kv boottime "\`kstat -p unix:0:system_misc:boot_time 2>/dev/null | cut -f2\`"
  if have diskinfo; then
    diskinfo -H 2>/dev/null | awk -F'	' '{ r="?"; if ($7=="yes"||$7=="Yes") r=0; else if ($7=="no"||$7=="No") r=1; print "DISK", $2, r }'
  else
    iostat -En 2>/dev/null | awk '/^c[0-9]/ {print "DISK", $1, "?"}'
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
