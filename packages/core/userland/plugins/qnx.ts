import type { Userland } from '../types';


export const Qnx: Userland = {
  id: 'qnx',
  label: 'QNX Neutrino',
  sysnames: ['QNX'],
  notes: 'pidin info: CPU, FreeMem:used/total, BootTime. ps supports -o on 6.x+.',
  body: `
  kv nproc "\`pidin info 2>/dev/null | grep -c '^Processor'\`"
  kv cpu "\`pidin info 2>/dev/null | sed -n 's/^Processor1: *//p' | sed -n 1p\`"
  kv mem_raw "\`pidin info 2>/dev/null | sed -n 's/.*FreeMem:\\([^ ]*\\).*/\\1/p' | sed -n 1p\`"
  kv boottime "\`pidin info 2>/dev/null | sed -n 's/.*BootTime:\\(.*\\)$/\\1/p' | sed -n 1p\`"
  ls /dev/hd? /dev/sd? 2>/dev/null | awk '{print "DISK", $1, "?"}' | sed 's|/dev/||'

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
