#!/usr/bin/env python3
"""Emit plugins/*.ts and registry.ts from Bourne-sh bodies written naturally
here — backticks and ${ are escaped for the TS template literal, which is
why the shell is authored in Python rather than in TypeScript. Run it with
`make userland-plugins` from the repo root, then commit both.

Read userland/types.ts for the wire contract every body must honour and
docs/architecture/userland-probe.md for the design."""
import os, textwrap

import pathlib
HERE = pathlib.Path(__file__).resolve().parent
OUT = str(HERE / 'plugins')

def ts(s: str) -> str:
    return s.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')

PLUGINS = []
def plugin(id, label, sysnames, body, refine=None, notes=None):
    PLUGINS.append(dict(id=id, label=label, sysnames=sysnames, body=body, refine=refine, notes=notes))

# ── shared fragments (pasted into bodies; the prelude has kv/have/first/sysctl_n/hprocs/nvidia/common) ──

PROCFS = r'''
  # /proc, as Linux, Hurd and Cygwin all present it.
  c=`sed -n '/^model name/{p;q;}' /proc/cpuinfo 2>/dev/null`
  [ -z "$c" ] && c=`sed -n '/^cpu model/{p;q;}' /proc/cpuinfo 2>/dev/null`
  [ -z "$c" ] && c=`sed -n '/^Model/{p;q;}' /proc/cpuinfo 2>/dev/null`
  [ -z "$c" ] && c=`sed -n '/^Hardware/{p;q;}' /proc/cpuinfo 2>/dev/null`
  [ -z "$c" ] && c=`sed -n '/^cpu[ 	]*:/{p;q;}' /proc/cpuinfo 2>/dev/null`
  [ -z "$c" ] && c=`{ grep '^CPU implementer' /proc/cpuinfo; grep '^CPU part' /proc/cpuinfo; } 2>/dev/null | sed -n '1,2p' | tr '\n' ' '`
  kv cpu "$c"
  kv mem_total "`sed -n 's/^MemTotal:[ 	]*//p' /proc/meminfo 2>/dev/null`"
  kv mem_avail "`sed -n 's/^MemAvailable:[ 	]*//p' /proc/meminfo 2>/dev/null`"
  kv mem_free "`sed -n 's/^MemFree:[ 	]*//p' /proc/meminfo 2>/dev/null`"
  kv mem_buffers "`sed -n 's/^Buffers:[ 	]*//p' /proc/meminfo 2>/dev/null`"
  kv mem_cached "`sed -n 's/^Cached:[ 	]*//p' /proc/meminfo 2>/dev/null`"
  kv swap_total "`sed -n 's/^SwapTotal:[ 	]*//p' /proc/meminfo 2>/dev/null`"
  kv swap_free "`sed -n 's/^SwapFree:[ 	]*//p' /proc/meminfo 2>/dev/null`"
  kv load "`first /proc/loadavg`"
  kv uptime_s "`first /proc/uptime | cut -d' ' -f1`"
'''

SYSFS_DISKS = r'''
  # Whole devices only live in /sys/block; a partition never does. A block
  # device without a `device` link is virtual (md, dm, zram, loop).
  if [ -d /sys/block ]; then
    for b in /sys/block/*; do
      n=`basename "$b"`
      case "$n" in loop*|ram*|zram*|dm-*|md*|sr*|fd*|nbd*|rbd*|drbd*|zd*) continue;; esac
      if [ -e "$b/device" ]; then
        r=`cat "$b/queue/rotational" 2>/dev/null`
        [ -z "$r" ] && r='?'
        echo "DISK $n $r"
      fi
    done
  elif have lsblk; then
    lsblk -d -n -o NAME,TYPE,ROTA 2>/dev/null | awk '$2=="disk" {print "DISK", $1, $3}'
  elif [ -r /proc/partitions ]; then
    # 2.4 kernels: no sysfs. Whole disks are the names that do not end in a digit.
    awk 'NR>2 && $4 !~ /[0-9]$/ && $4 !~ /^(loop|ram|md)/ {print "DISK", $4, "?"}' /proc/partitions 2>/dev/null
  fi
'''

RAPL = r'''
  # Intel RAPL: two energy readings a known interval apart. Old sleep
  # cannot do fractions; report which interval we actually got.
  e0=/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj
  e1=/sys/class/powercap/intel-rapl/intel-rapl:1/energy_uj
  if [ -r "$e0" ]; then
    r1=`cat "$e0" 2>/dev/null`; r1b=`cat "$e1" 2>/dev/null`
    if sleep 0.1 2>/dev/null; then dt=0.1; else sleep 1; dt=1; fi
    r2=`cat "$e0" 2>/dev/null`; r2b=`cat "$e1" 2>/dev/null`
    echo "RAPL $r1 ${r1b:-0} $r2 ${r2b:-0} $dt"
  fi
'''

# ps-table fallbacks, most faithful first. Each yields the 11-column shape.
PS_AUX_OR_EO = r'''
  if ps aux 2>/dev/null | sed -n 1p | grep '%CPU' >/dev/null 2>&1; then
    ps aux 2>/dev/null | hprocs
  elif ps -eo user,pid,pcpu,pmem,vsz,rss,tty,s,stime,time,args 2>/dev/null | sed -n 1p | grep -i 'pid' >/dev/null 2>&1; then
    ps -eo user,pid,pcpu,pmem,vsz,rss,tty,s,stime,time,args 2>/dev/null | hprocs
  elif ps -eo user,pid,pcpu,pmem,vsz,rss,tty,state,stime,time,args 2>/dev/null | sed -n 1p | grep -i 'pid' >/dev/null 2>&1; then
    ps -eo user,pid,pcpu,pmem,vsz,rss,tty,state,stime,time,args 2>/dev/null | hprocs
  else
    psef | hprocs
  fi
'''

# ── Tier 1: GNU/Linux and its siblings ──────────────────────────────────

plugin('linux-android', 'Android (toybox / Termux)', ['Linux'],
  refine='[ "$O" = Android ] || [ -r /system/build.prop ] || have toybox || have getprop',
  notes='Termux sshd or adb. toybox ps takes -o with %CPU/%MEM; older Android ps prints USER PID PPID VSIZE RSS WCHAN PC NAME.',
  body=r'''
  kv nproc "`nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null`"
''' + PROCFS + r'''
  if have getprop; then
    kv model "`getprop ro.product.model 2>/dev/null`"
    kv soc "`getprop ro.soc.model 2>/dev/null || getprop ro.hardware.chipname 2>/dev/null || getprop ro.board.platform 2>/dev/null`"
    kv osrel "Android `getprop ro.build.version.release 2>/dev/null` (`uname -r 2>/dev/null`)"
  fi
''' + SYSFS_DISKS + r'''
  if ps -A -o user,pid,%cpu,%mem,vsz,rss,tty,stat,stime,time,args 2>/dev/null | sed -n 1p | grep -i pid >/dev/null 2>&1; then
    ps -A -o user,pid,%cpu,%mem,vsz,rss,tty,stat,stime,time,args 2>/dev/null | hprocs
  elif ps aux 2>/dev/null | sed -n 1p | grep '%CPU' >/dev/null 2>&1; then
    ps aux 2>/dev/null | hprocs
  else
    ps 2>/dev/null | awk 'NR>1 && NF>=9 { printf "%s %s 0.0 0.0 %s %s ? S - 0:00 %s\n", $1, $2, $4, $5, $NF }' | hprocs
  fi
''')

plugin('linux-busybox', 'Linux (busybox)', ['Linux'],
  refine='have busybox && test "`ps --version 2>&1 | grep -ic procps`" = 0',
  notes='Alpine, OpenWrt, initramfs, most NAS firmware. busybox ps has no %CPU/%MEM and ignores `aux`; its -o list is narrow.',
  body=r'''
  kv nproc "`nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null`"
''' + PROCFS + SYSFS_DISKS + r'''
  if ps aux 2>/dev/null | sed -n 1p | grep '%CPU' >/dev/null 2>&1; then
    ps aux 2>/dev/null | hprocs
  elif ps -o user,pid,vsz,rss,tty,stat,time,args 2>/dev/null | sed -n 1p | grep -i user >/dev/null 2>&1; then
    ps -o user,pid,vsz,rss,tty,stat,time,args 2>/dev/null | awk 'NR>1 { printf "%s %s 0.0 0.0 %s %s %s %s - %s", $1, $2, $3, $4, $5, $6, $7; for (i=8; i<=NF; i++) printf " %s", $i; printf "\n" }' | hprocs
  else
    ps 2>/dev/null | awk 'NR>1 { printf "%s %s 0.0 0.0 0 0 ? S - %s", $2, $1, $3; for (i=4; i<=NF; i++) printf " %s", $i; printf "\n" }' | hprocs
  fi
''' + RAPL + '''
  nvidia
''')

plugin('linux-gnu', 'GNU/Linux', ['Linux'],
  notes='The reference: procps ps, coreutils, sysfs. Every other plugin is measured against what this one reports.',
  body=r'''
  kv nproc "`nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null`"
''' + PROCFS + SYSFS_DISKS + '''
  ps aux 2>/dev/null | hprocs
''' + RAPL + '''
  nvidia
  if have rocm-smi; then rocm-smi --showpower --showuse --showmemuse --csv 2>/dev/null | sed 's/^/AMDGPU /'; fi
''')



plugin('gnu-hurd', 'GNU/Hurd', ['GNU'],
  notes='Debian GNU/Hurd. procfs translator serves cpuinfo, meminfo, loadavg, uptime; Hurd ps understands `aux`.',
  body=r'''
  kv nproc "`nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null`"
''' + PROCFS + r'''
  for d in /dev/hd? /dev/sd? /dev/wd?; do [ -e "$d" ] && echo "DISK `basename $d` ?"; done
''' + PS_AUX_OR_EO)

# ── Tier 1: BSD family ──────────────────────────────────────────────────

plugin('freebsd', 'FreeBSD', ['FreeBSD', 'MidnightBSD', 'DragonFly', 'GNU/kFreeBSD'],
  notes='FreeBSD, DragonFly, MidnightBSD, Debian GNU/kFreeBSD. sysctl for everything; diskinfo -v reports rotation rate on 12+.',
  body=r'''
  kv nproc "`sysctl_n hw.ncpu`"
  kv cpu "`sysctl_n hw.model`"
  kv pagesize "`sysctl_n hw.pagesize`"
  kv mem_total "`sysctl_n hw.physmem` B"
  kv mem_avail "`sysctl_n vm.stats.vm.v_free_count` `sysctl_n vm.stats.vm.v_inactive_count` `sysctl_n vm.stats.vm.v_cache_count` pages"
  if have swapinfo; then
    swapinfo -k 2>/dev/null | awk 'NR>1 && $1!="Total" {t+=$2; u+=$3} END {print "swap_total=" t " kB"; print "swap_used=" u " kB"}'
  fi
  kv load "`sysctl_n vm.loadavg`"
  kv boottime "`sysctl_n kern.boottime`"
  for d in `sysctl_n kern.disks` `sysctl_n hw.disknames`; do
    case "$d" in cd*|acd*|md*|fd*|vn*) continue;; nvd*|nda*|nvme*) echo "DISK $d 0"; continue;; esac
    r=`diskinfo -v /dev/$d 2>/dev/null | grep -i 'rotation rate' | awk '{print $1}'`
    case "$r" in 0) echo "DISK $d 0";; ''|[Uu]nknown) echo "DISK $d ?";; *) echo "DISK $d 1";; esac
  done
''' + PS_AUX_OR_EO + '''
  nvidia
''')

plugin('openbsd', 'OpenBSD', ['OpenBSD'],
  notes='hw.physmem64 for >4GB; vm.loadavg is three bare numbers; kern.boottime is an epoch. top -n prints Free: NNNM.',
  body=r'''
  kv nproc "`sysctl_n hw.ncpuonline`"
  [ -z "`sysctl_n hw.ncpuonline`" ] && kv nproc "`sysctl_n hw.ncpu`"
  kv cpu "`sysctl_n hw.model`"
  kv pagesize "`sysctl_n hw.pagesize`"
  m=`sysctl_n hw.physmem64`; [ -z "$m" ] && m=`sysctl_n hw.physmem`
  kv mem_total "$m B"
  kv mem_avail "`top -n 1 2>/dev/null | sed -n 's/.*Free: *\([0-9]*[KMG]\).*/\1/p' | sed -n 1p`"
  kv swap_raw "`swapctl -sk 2>/dev/null`"
  kv load "`sysctl_n vm.loadavg`"
  kv boottime "`sysctl_n kern.boottime`"
  for d in `sysctl_n hw.disknames | tr ',' ' '`; do
    n=`echo "$d" | cut -d: -f1`
    case "$n" in cd*|fd*|vnd*|rd*|'') continue;; esac
    echo "DISK $n ?"
  done
''' + PS_AUX_OR_EO)

plugin('netbsd', 'NetBSD', ['NetBSD', 'Minix'],
  notes='NetBSD and MINIX 3.2+ (NetBSD userland). top -b prints "NNNM Free"; hw.disknames is space-separated.',
  body=r'''
  kv nproc "`sysctl_n hw.ncpuonline`"
  [ -z "`sysctl_n hw.ncpuonline`" ] && kv nproc "`sysctl_n hw.ncpu`"
  kv cpu "`sysctl_n hw.model`"
  kv pagesize "`sysctl_n hw.pagesize`"
  m=`sysctl_n hw.physmem64`; [ -z "$m" ] && m=`sysctl_n hw.physmem`
  kv mem_total "$m B"
  kv mem_avail "`top -b -n 1 2>/dev/null | sed -n 's/.*[ ,]\([0-9]*[KMG]\) Free.*/\1/p' | sed -n 1p`"
  [ -z "`top -b -n 1 2>/dev/null | grep Free`" ] && kv mem_avail "`vmstat 2>/dev/null | tail -1 | awk '{print $5 " kB"}'`"
  kv swap_raw "`swapctl -sk 2>/dev/null`"
  kv load "`sysctl_n vm.loadavg`"
  kv boottime "`sysctl_n kern.boottime`"
  for n in `sysctl_n hw.disknames`; do
    case "$n" in cd*|fd*|vnd*|md*|dk*|raid*|'') continue;; esac
    echo "DISK $n ?"
  done
''' + PS_AUX_OR_EO)

plugin('darwin', 'macOS', ['Darwin'],
  notes='sysctl + vm_stat + diskutil. Apple silicon reports machdep.cpu.brand_string as "Apple M1". No RAPL, no nvidia-smi.',
  body=r'''
  kv nproc "`sysctl_n hw.ncpu`"
  kv cpu "`sysctl_n machdep.cpu.brand_string`"
  kv pagesize "`sysctl_n hw.pagesize`"
  kv mem_total "`sysctl_n hw.memsize` B"
  kv mem_avail "`vm_stat 2>/dev/null | awk '/Pages (free|inactive|speculative):/ {gsub(/\./, "", $NF); s+=$NF} END {print s " pages"}'`"
  kv swap_raw "`sysctl_n vm.swapusage`"
  kv load "`sysctl_n vm.loadavg`"
  kv boottime "`sysctl_n kern.boottime`"
  kv model "`sysctl_n hw.model`"
  for d in `diskutil list 2>/dev/null | grep '^/dev/disk' | grep -v -e synthesized -e virtual -e 'disk image' | awk '{print $1}'`; do
    s=`diskutil info "$d" 2>/dev/null | grep 'Solid State' | awk '{print $NF}'`
    case "$s" in Yes) echo "DISK `basename $d` 0";; No) echo "DISK `basename $d` 1";; *) echo "DISK `basename $d` ?";; esac
  done
''' + PS_AUX_OR_EO)

# ── Tier 1: System V family ─────────────────────────────────────────────

plugin('sunos', 'Solaris / illumos', ['SunOS'],
  notes='Solaris 8–11, OpenIndiana, SmartOS, OmniOS. /usr/xpg4/bin first on PATH gives POSIX ps/awk. kstat is the truth for memory and boot time; illumos diskinfo -H says SSD yes/no.',
  body=r'''
  kv nproc "`psrinfo 2>/dev/null | wc -l | awk '{print $1}'`"
  c=`kstat -p cpu_info:0:cpu_info0:brand 2>/dev/null | cut -f2`
  [ -z "$c" ] && c=`psrinfo -pv 2>/dev/null | sed -n '$p' | sed 's/^[ 	]*//'`
  kv cpu "$c"
  kv isa "`isainfo -k 2>/dev/null || uname -p 2>/dev/null`"
  kv pagesize "`pagesize 2>/dev/null`"
  kv mem_total "`prtconf 2>/dev/null | sed -n 's/^Memory size: *//p'`"
  kv mem_avail "`kstat -p unix:0:system_pages:freemem 2>/dev/null | cut -f2` pages"
  kv swap_raw "`swap -s 2>/dev/null`"
  kv boottime "`kstat -p unix:0:system_misc:boot_time 2>/dev/null | cut -f2`"
  if have diskinfo; then
    diskinfo -H 2>/dev/null | awk -F'	' '{ r="?"; if ($7=="yes"||$7=="Yes") r=0; else if ($7=="no"||$7=="No") r=1; print "DISK", $2, r }'
  else
    iostat -En 2>/dev/null | awk '/^c[0-9]/ {print "DISK", $1, "?"}'
  fi
''' + PS_AUX_OR_EO)

plugin('aix', 'AIX', ['AIX', 'OS400'],
  notes='AIX 5–7 and IBM i PASE. prtconf carries model, cores, memory; vmstat fre is 4K pages; lsps -s is the paging space; ps aux works without the dash.',
  body=r'''
  kv nproc "`prtconf 2>/dev/null | sed -n 's/^Number Of Processors: *//p'`"
  [ -z "`prtconf 2>/dev/null | grep '^Number Of Processors'`" ] && kv nproc "`lsdev -Cc processor 2>/dev/null | grep -c Available`"
  kv cpu "`prtconf 2>/dev/null | sed -n 's/^Processor Type: *//p'` @ `prtconf 2>/dev/null | sed -n 's/^Processor Clock Speed: *//p'`"
  kv isa "`uname -p 2>/dev/null`"
  kv pagesize "`pagesize 2>/dev/null`"
  kv mem_total "`prtconf 2>/dev/null | sed -n 's/^Memory Size: *//p'`"
  kv mem_avail "`vmstat 1 1 2>/dev/null | tail -1 | awk '{print $4 " pages"}'`"
  kv swap_raw "`lsps -s 2>/dev/null | tail -1`"
  lsdev -Cc disk 2>/dev/null | awk '{print "DISK", $1, "?"}'
''' + PS_AUX_OR_EO)

plugin('hp-ux', 'HP-UX', ['HP-UX'],
  notes='HP-UX 11i. UNIX95=1 (set in the prelude) unlocks ps -o. machinfo on 11i v2+, ioscan for counts, swapinfo -tm for paging.',
  body=r'''
  kv nproc "`ioscan -kfnC processor 2>/dev/null | grep -c processor`"
  c=`machinfo 2>/dev/null | grep -i -e 'processor model' -e 'Intel(R)' -e 'PA-RISC' | sed -n 1p | sed 's/^[ 	]*//'`
  [ -z "$c" ] && c=`model 2>/dev/null`
  kv cpu "$c"
  kv mem_total "`machinfo 2>/dev/null | grep -i '^Memory' | sed 's/.*= *\([0-9]*\) *\([A-Za-z]*\).*/\1 \2/'`"
  kv pagesize "`getconf PAGESIZE 2>/dev/null || getconf PAGE_SIZE 2>/dev/null`"
  kv mem_avail "`vmstat 1 1 2>/dev/null | tail -1 | awk '{print $5 " pages"}'`"
  kv swap_raw "`swapinfo -tm 2>/dev/null | grep '^total'`"
  ioscan -kfnC disk 2>/dev/null | awk '/^disk/ {print "DISK disk" $2, "?"}'
''' + PS_AUX_OR_EO)

plugin('irix', 'IRIX', ['IRIX', 'IRIX64'],
  notes='SGI IRIX 6.x. hinv is the hardware inventory; sar -r has freemem in pages. Disks of the era spin.',
  body=r'''
  kv nproc "`hinv -c processor 2>/dev/null | sed -n 's/^\([0-9][0-9]*\) .*[Pp]rocessor.*/\1/p' | sed -n 1p`"
  [ -z "`hinv -c processor 2>/dev/null`" ] && kv nproc "`sysconf NPROC_ONLN 2>/dev/null`"
  kv cpu "`hinv -c processor 2>/dev/null | grep -i 'CPU:' | sed -n 1p | sed 's/^CPU: *//'`"
  kv mem_total "`hinv -c memory 2>/dev/null | sed -n 's/^Main memory size: *//p'`"
  kv pagesize "`getconf PAGESIZE 2>/dev/null || sysconf PAGESIZE 2>/dev/null`"
  kv mem_avail "`sar -r 1 1 2>/dev/null | tail -1 | awk '{print $2 " pages"}'`"
  kv swap_raw "`swap -s 2>/dev/null`"
  hinv -c disk 2>/dev/null | grep -i 'disk drive' | awk '{print "DISK dks" NR, "1"}'
''' + PS_AUX_OR_EO)

plugin('osf1', 'Tru64 UNIX', ['OSF1'],
  notes='DEC/Compaq/HP Tru64 on Alpha. vmstat -P for physical memory, psrinfo for CPUs, hwmgr for devices. ps takes BSD flags.',
  body=r'''
  kv nproc "`psrinfo 2>/dev/null | wc -l | awk '{print $1}'`"
  kv cpu "`psrinfo -v 2>/dev/null | grep -i processor | sed -n 1p | sed 's/^[ 	]*//'`"
  kv mem_total "`vmstat -P 2>/dev/null | sed -n 's/^Total Physical Memory *= *//p' | sed 's/(.*//'`"
  kv pagesize "`getconf PAGESIZE 2>/dev/null`"
  kv mem_avail "`vmstat -P 2>/dev/null | sed -n 's/^ *Free Pages *= *//p' | awk '{print $1 " pages"}'`"
  kv swap_raw "`swapon -s 2>/dev/null | grep -i -e 'Allocated space' -e 'Available space' | tr '\n' ' '`"
  hwmgr -view devices 2>/dev/null | grep -i disk | awk '{print "DISK", $NF, "?"}'
''' + PS_AUX_OR_EO)

plugin('sco', 'SCO OpenServer / UnixWare', ['UnixWare', 'SCO_SV'],
  notes='uname -X prints NumCPU on both; psrinfo exists on UnixWare; memsize on OpenServer; disks are /dev/rdsk/c?b?t?d?s?.',
  body=r'''
  kv nproc "`uname -X 2>/dev/null | sed -n 's/^NumCPU *= *//p'`"
  kv cpu "`psrinfo -v 2>/dev/null | grep -i -e processor -e operates | sed -n 1p | sed 's/^[ 	]*//'`"
  kv mem_total "`memsize 2>/dev/null` B"
  kv mem_avail "`sar -r 1 1 2>/dev/null | tail -1 | awk '{print $2 " pages"}'`"
  kv pagesize "`getconf PAGESIZE 2>/dev/null`"
  kv swap_raw "`swap -s 2>/dev/null`"
  ls /dev/rdsk 2>/dev/null | sed 's/s[0-9]*$//' | sort -u | awk '{print "DISK", $1, "1"}'
''' + PS_AUX_OR_EO)

# ── Tier 2: the rest of the shell-bearing world ─────────────────────────

plugin('haiku', 'Haiku', ['Haiku'],
  notes='sysinfo -cpu / -mem. No load average concept; ps is teams not processes, so no harness rows.',
  body=r'''
  kv nproc "`sysinfo -cpu 2>/dev/null | grep -c '^CPU #'`"
  kv cpu "`sysinfo -cpu 2>/dev/null | sed -n 's/^CPU #0: *//p' | sed -n 1p`"
  kv mem_raw "`sysinfo -mem 2>/dev/null | sed -n 1p`"
''')

plugin('qnx', 'QNX Neutrino', ['QNX'],
  notes='pidin info: CPU, FreeMem:used/total, BootTime. ps supports -o on 6.x+.',
  body=r'''
  kv nproc "`pidin info 2>/dev/null | grep -c '^Processor'`"
  kv cpu "`pidin info 2>/dev/null | sed -n 's/^Processor1: *//p' | sed -n 1p`"
  kv mem_raw "`pidin info 2>/dev/null | sed -n 's/.*FreeMem:\([^ ]*\).*/\1/p' | sed -n 1p`"
  kv boottime "`pidin info 2>/dev/null | sed -n 's/.*BootTime:\(.*\)$/\1/p' | sed -n 1p`"
  ls /dev/hd? /dev/sd? 2>/dev/null | awk '{print "DISK", $1, "?"}' | sed 's|/dev/||'
''' + PS_AUX_OR_EO)

plugin('cygwin', 'Cygwin / MSYS2 / MinGW', ['CYGWIN_NT*', 'MSYS_NT*', 'MINGW32_NT*', 'MINGW64_NT*'],
  notes='Cygwin fakes /proc well enough to use it. Physical disks come from PowerShell (Win8+) or wmic (older). Cygwin ps is its own shape.',
  body=r'''
  kv nproc "`nproc 2>/dev/null || echo $NUMBER_OF_PROCESSORS`"
''' + PROCFS + r'''
  if have powershell; then
    powershell -NoProfile -NonInteractive -Command "Get-PhysicalDisk | ForEach-Object { 'DISK ' + (\$_.FriendlyName -replace ' ','_') + ' ' + \$(if (\$_.MediaType -eq 'SSD') {0} elseif (\$_.MediaType -eq 'HDD') {1} else {'?'}) }" 2>/dev/null | tr -d '\r'
  fi
  if have wmic; then
    wmic diskdrive get Index,MediaType /format:csv 2>/dev/null | tr -d '\r' | awk -F, 'NR>2 && $2!="" {print "DISK disk" $2, "?"}'
  fi
  ps -ef 2>/dev/null | awk 'NR>1 { printf "%s %s 0.0 0.0 0 0 %s S %s 0:00", $1, $2, $4, $5; for (i=6; i<=NF; i++) printf " %s", $i; printf "\n" }' | hprocs
  nvidia
''')

plugin('windows-sh', 'Windows (busybox-w32 / UnxUtils sh)', ['Windows_NT', 'WindowsNT', 'Windows NT'],
  notes='A Bourne shell on bare Windows. Hands the same PowerShell script the native path uses to powershell on stdin; falls back to environment + wmic.',
  body=r'''
  kv hostname "$COMPUTERNAME"
  kv nproc "$NUMBER_OF_PROCESSORS"
  kv cpu "$PROCESSOR_IDENTIFIER"
  kv arch "$PROCESSOR_ARCHITECTURE"
  if have powershell; then
    powershell -NoProfile -NonInteractive -Command - <<'__UF_PS__' 2>/dev/null | tr -d '\r' | grep -v '^uf=1$' | grep -v '^END$'
__POWERSHELL__
__UF_PS__
  elif have wmic; then
    wmic cpu get Name /value 2>/dev/null | tr -d '\r' | sed -n 's/^Name=/cpu=/p'
    wmic OS get TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime /value 2>/dev/null | tr -d '\r' | sed -n 's/^TotalVisibleMemorySize=\(.*\)/mem_total=\1 kB/p; s/^FreePhysicalMemory=\(.*\)/mem_avail=\1 kB/p; s/^LastBootUpTime=/boottime=/p'
    wmic pagefile get AllocatedBaseSize,CurrentUsage /value 2>/dev/null | tr -d '\r' | sed -n 's/^AllocatedBaseSize=\(.*\)/swap_total=\1 MB/p; s/^CurrentUsage=\(.*\)/swap_used=\1 MB/p'
    wmic diskdrive get Index,MediaType /format:csv 2>/dev/null | tr -d '\r' | awk -F, 'NR>2 && $2!="" {print "DISK disk" $2, "?"}'
  fi
  nvidia
''')

plugin('windows-powershell', 'Windows (PowerShell)', [],
  notes='Not a Bourne branch: what probeRemote runs when the remote has no sh at all. The script is userland/powershell.ts; this entry names the id the wire reports.',
  body='')

plugin('generic', 'Generic POSIX', ['*'],
  notes='Interix, z/OS USS, NonStop OSS, SINIX, ReliantUNIX, ULTRIX, A/UX, UNICOS, SerenityOS, Redox, and whatever comes next. Asks only what POSIX promises, then tries sysctl and /proc in case they are there.',
  body=r'''
  kv nproc "`getconf _NPROCESSORS_ONLN 2>/dev/null || getconf NPROCESSORS_ONLN 2>/dev/null || sysconf NPROC_ONLN 2>/dev/null`"
  kv cpu "`uname -p 2>/dev/null`"
  kv pagesize "`getconf PAGESIZE 2>/dev/null || getconf PAGE_SIZE 2>/dev/null`"
  if have sysctl; then
    [ -n "`sysctl_n hw.model`" ] && kv cpu "`sysctl_n hw.model`"
    [ -n "`sysctl_n hw.ncpu`" ] && kv nproc "`sysctl_n hw.ncpu`"
    [ -n "`sysctl_n hw.physmem`" ] && kv mem_total "`sysctl_n hw.physmem` B"
    [ -n "`sysctl_n vm.loadavg`" ] && kv load "`sysctl_n vm.loadavg`"
    [ -n "`sysctl_n kern.boottime`" ] && kv boottime "`sysctl_n kern.boottime`"
  fi
  if [ -r /proc/meminfo ]; then
''' + textwrap.indent(PROCFS, '  ') + r'''
  fi
''' + PS_AUX_OR_EO)

# ── emit ────────────────────────────────────────────────────────────────

os.makedirs(OUT, exist_ok=True)
index_lines = []
for p in PLUGINS:
    name = p['id']
    var = ''.join(w.capitalize() for w in name.split('-'))
    body = p['body'].strip('\n')
    ps_marker = '__POWERSHELL__'
    if ps_marker in body:
        head, tail = body.split(ps_marker)
        body_ts = '`\n' + ts(head) + '` + POWERSHELL_SCRIPT + `' + ts(tail) + '`'
        imp = "import type { Userland } from '../types';\nimport { POWERSHELL_SCRIPT } from '../powershell';\n"
    else:
        body_ts = '`\n' + ts(body) + '`'
        imp = "import type { Userland } from '../types';\n"
    lines = [imp, '', f'export const {var}: Userland = {{', f"  id: '{name}',", f"  label: '{p['label']}',",
             '  sysnames: [' + ', '.join(f"'{s}'" for s in p['sysnames']) + '],']
    if p['refine']:
        lines.append('  refine: ' + '`' + ts(p['refine']) + '`,')
    if p['notes']:
        lines.append("  notes: '" + p['notes'].replace("'", "\\'") + "',")
    lines.append('  body: ' + body_ts + ',')
    lines.append('};')
    lines.append('')
    open(os.path.join(OUT, name + '.ts'), 'w').write('\n'.join(lines))
    index_lines.append((name, var))

reg = "// Generated plugin list — order matters: the first plugin whose sysname\n// pattern matches and whose refine test passes is the one that runs.\n"
reg += ''.join(f"import {{ {v} }} from './plugins/{n}';\n" for n, v in index_lines)
reg += "\nexport const USERLANDS = [\n" + ''.join(f'  {v},\n' for _, v in index_lines) + '];\n'
open(HERE / 'registry.ts', 'w').write(reg)
print('wrote', len(PLUGINS), 'plugins')
