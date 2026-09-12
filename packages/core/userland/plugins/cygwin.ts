import type { Userland } from '../types';


export const Cygwin: Userland = {
  id: 'cygwin',
  label: 'Cygwin / MSYS2 / MinGW',
  sysnames: ['CYGWIN_NT*', 'MSYS_NT*', 'MINGW32_NT*', 'MINGW64_NT*'],
  notes: 'Cygwin fakes /proc well enough to use it. Physical disks come from PowerShell (Win8+) or wmic (older). Cygwin ps is its own shape.',
  body: `
  kv nproc "\`nproc 2>/dev/null || echo $NUMBER_OF_PROCESSORS\`"

  # /proc, as Linux, Hurd and Cygwin all present it.
  c=\`sed -n '/^model name/{p;q;}' /proc/cpuinfo 2>/dev/null\`
  [ -z "$c" ] && c=\`sed -n '/^cpu model/{p;q;}' /proc/cpuinfo 2>/dev/null\`
  [ -z "$c" ] && c=\`sed -n '/^Model/{p;q;}' /proc/cpuinfo 2>/dev/null\`
  [ -z "$c" ] && c=\`sed -n '/^Hardware/{p;q;}' /proc/cpuinfo 2>/dev/null\`
  [ -z "$c" ] && c=\`sed -n '/^cpu[ 	]*:/{p;q;}' /proc/cpuinfo 2>/dev/null\`
  [ -z "$c" ] && c=\`{ grep '^CPU implementer' /proc/cpuinfo; grep '^CPU part' /proc/cpuinfo; } 2>/dev/null | sed -n '1,2p' | tr '\\n' ' '\`
  kv cpu "$c"
  kv mem_total "\`sed -n 's/^MemTotal:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv mem_avail "\`sed -n 's/^MemAvailable:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv mem_free "\`sed -n 's/^MemFree:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv mem_buffers "\`sed -n 's/^Buffers:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv mem_cached "\`sed -n 's/^Cached:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv swap_total "\`sed -n 's/^SwapTotal:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv swap_free "\`sed -n 's/^SwapFree:[ 	]*//p' /proc/meminfo 2>/dev/null\`"
  kv load "\`first /proc/loadavg\`"
  kv uptime_s "\`first /proc/uptime | cut -d' ' -f1\`"

  if have powershell; then
    powershell -NoProfile -NonInteractive -Command "Get-PhysicalDisk | ForEach-Object { 'DISK ' + (\\$_.FriendlyName -replace ' ','_') + ' ' + \\$(if (\\$_.MediaType -eq 'SSD') {0} elseif (\\$_.MediaType -eq 'HDD') {1} else {'?'}) }" 2>/dev/null | tr -d '\\r'
  fi
  if have wmic; then
    wmic diskdrive get Index,MediaType /format:csv 2>/dev/null | tr -d '\\r' | awk -F, 'NR>2 && $2!="" {print "DISK disk" $2, "?"}'
  fi
  ps -ef 2>/dev/null | awk 'NR>1 { printf "%s %s 0.0 0.0 0 0 %s S %s 0:00", $1, $2, $4, $5; for (i=6; i<=NF; i++) printf " %s", $i; printf "\\n" }' | hprocs
  nvidia`,
};
