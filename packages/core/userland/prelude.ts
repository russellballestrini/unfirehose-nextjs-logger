import { harnessPsAwk } from '../harness-procs';

/**
 * Shell helpers every plugin body may call. Written for the Bourne shell
 * of 1979, because that is what `/bin/sh` still is on Solaris 10, HP-UX,
 * AIX and IRIX: backticks not `$( )`, no `$(( ))`, no `!`, no `[[ ]]`,
 * no `local`, no `command -v`. The one liberty is shell functions, which
 * SVR2 added in 1984.
 */
export const PRELUDE = `# unfirehose userland probe, wire v1. Bourne sh only — see userland/types.ts.
PATH=/usr/xpg4/bin:/usr/xpg6/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/usr/local/sbin:/opt/local/bin:/opt/homebrew/bin:/usr/contrib/bin:/usr/bsd:/usr/pkg/bin:/usr/pkg/sbin:/system/bin:/system/xbin:/data/data/com.termux/files/usr/bin:$PATH:/usr/ucb
export PATH
UNIX95=1; export UNIX95
LC_ALL=C; export LC_ALL
LANG=C; export LANG
# kv KEY VALUE — one wire line. Newlines in VALUE would forge keys: take the first line.
kv() { v=\`echo "$2" | sed -n 1p\`; echo "$1=$v"; }
# have CMD — is it on PATH and executable. \`type\` returns 0 even for "not found" on old sh.
have() { for d in \`echo "$PATH" | tr ':' ' '\`; do if [ -x "$d/$1" ]; then return 0; fi; done; return 1; }
# first FILE — first line of a file, or nothing.
first() { if [ -r "$1" ]; then sed -n 1p "$1" 2>/dev/null; fi; }
# sysctl_n NAME — sysctl -n, empty when unsupported.
sysctl_n() { sysctl -n "$1" 2>/dev/null; }
# hprocs — filter a ps table (11 columns, ps aux shape) down to harness rows.
hprocs() { awk '${harnessPsAwk().replace(/'/g, `'\\''`)}' 2>/dev/null | sed 's/^/HPROC /'; }
# psef — the POSIX-minimum table, reshaped to the 11 columns. STIME with a
# space in it ("Sep 12") shifts the row; it is the last resort, not the first.
psef() { ps -ef 2>/dev/null | awk 'NR>1 { printf "%s %s 0.0 0.0 0 0 %s S %s %s", $1, $2, $6, $5, $7; for (i=8; i<=NF; i++) printf " %s", $i; printf "\n" }'; }
# common — what every userland can say for itself. \`kind\` says what the
# machine is for: compute (the default), a hypervisor, or network gear —
# Junos, and the Linuxes under Arista EOS and Cisco NX-OS.
common() {
  kind=compute
  case "$S" in VMkernel) kind=hypervisor;; JUNOS) kind=network;; esac
  if [ -x /usr/bin/Cli ] && [ -d /etc/eos ]; then kind=network; fi
  if [ -x /isan/bin/vsh ]; then kind=network; fi
  kv kind "$kind"
  kv hostname "\`hostname -f 2>/dev/null || hostname 2>/dev/null || uname -n 2>/dev/null\`"
  kv now "\`date +%s 2>/dev/null\`"
  kv osrel "\`uname -r 2>/dev/null\`"
  kv arch "\`uname -m 2>/dev/null\`"
  kv etime1 "\`ps -o etime= -p 1 2>/dev/null\`"
  kv uptime_raw "\`uptime 2>/dev/null\`"
}
# nvidia — GPU rows where the driver ships nvidia-smi (Linux, FreeBSD, Windows).
nvidia() {
  if have nvidia-smi; then
    nvidia-smi --query-gpu=power.draw,name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | sed 's/^/GPU /'
  fi
}
`;
