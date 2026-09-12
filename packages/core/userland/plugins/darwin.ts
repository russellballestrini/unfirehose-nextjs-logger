import type { Userland } from '../types';


export const Darwin: Userland = {
  id: 'darwin',
  label: 'macOS',
  sysnames: ['Darwin'],
  notes: 'sysctl + vm_stat + diskutil. Apple silicon reports machdep.cpu.brand_string as "Apple M1". No RAPL, no nvidia-smi.',
  body: `
  kv nproc "\`sysctl_n hw.ncpu\`"
  kv cpu "\`sysctl_n machdep.cpu.brand_string\`"
  kv pagesize "\`sysctl_n hw.pagesize\`"
  kv mem_total "\`sysctl_n hw.memsize\` B"
  kv mem_avail "\`vm_stat 2>/dev/null | awk '/Pages (free|inactive|speculative):/ {gsub(/\\./, "", $NF); s+=$NF} END {print s " pages"}'\`"
  kv swap_raw "\`sysctl_n vm.swapusage\`"
  kv load "\`sysctl_n vm.loadavg\`"
  kv boottime "\`sysctl_n kern.boottime\`"
  kv model "\`sysctl_n hw.model\`"
  for d in \`diskutil list 2>/dev/null | grep '^/dev/disk' | grep -v -e synthesized -e virtual -e 'disk image' | awk '{print $1}'\`; do
    s=\`diskutil info "$d" 2>/dev/null | grep 'Solid State' | awk '{print $NF}'\`
    case "$s" in Yes) echo "DISK \`basename $d\` 0";; No) echo "DISK \`basename $d\` 1";; *) echo "DISK \`basename $d\` ?";; esac
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
