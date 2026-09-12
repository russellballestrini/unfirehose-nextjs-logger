import type { Userland } from '../types';


export const HpUx: Userland = {
  id: 'hp-ux',
  label: 'HP-UX',
  sysnames: ['HP-UX'],
  notes: 'HP-UX 11i. UNIX95=1 (set in the prelude) unlocks ps -o. machinfo on 11i v2+, ioscan for counts, swapinfo -tm for paging.',
  body: `
  kv nproc "\`ioscan -kfnC processor 2>/dev/null | grep -c processor\`"
  c=\`machinfo 2>/dev/null | grep -i -e 'processor model' -e 'Intel(R)' -e 'PA-RISC' | sed -n 1p | sed 's/^[ 	]*//'\`
  [ -z "$c" ] && c=\`model 2>/dev/null\`
  kv cpu "$c"
  kv mem_total "\`machinfo 2>/dev/null | grep -i '^Memory' | sed 's/.*= *\\([0-9]*\\) *\\([A-Za-z]*\\).*/\\1 \\2/'\`"
  kv pagesize "\`getconf PAGESIZE 2>/dev/null || getconf PAGE_SIZE 2>/dev/null\`"
  kv mem_avail "\`vmstat 1 1 2>/dev/null | tail -1 | awk '{print $5 " pages"}'\`"
  kv swap_raw "\`swapinfo -tm 2>/dev/null | grep '^total'\`"
  ioscan -kfnC disk 2>/dev/null | awk '/^disk/ {print "DISK disk" $2, "?"}'

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
