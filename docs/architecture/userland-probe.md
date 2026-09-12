# The userland probe

How a mesh node reports itself, for every operating system an sshd can put
a shell on. Code: `packages/core/userland/`.

## Why

The remote probe was a `&&`-chain of Linux commands (`nproc`, `/proc/*`,
`lsblk`, `ps aux --sort`) passed to the remote *login shell* as an argument.
Anything that was not GNU/Linux from about 2010 on read as "Unreachable" —
one missing command failed the chain, and a csh login shell failed the
syntax before the first command ran. Someone who gets SSH working on an old
box, a BSD, a Mac or a Windows machine and then sees no metrics is exactly
the person we built this for.

## Shape

```
buildProbeScript()  ──►  one Bourne-shell script, on stdin, to `ssh host sh`
                          ├─ prelude: kv/have/first/sysctl_n/hprocs/psef/common/nvidia
                          ├─ detect:  case "`uname -s`" in … esac   (+ refine tests)
                          └─ run:     case "$ul" in <plugin body> … esac
parseWireProbe()    ◄──  key=value lines + DISK/HPROC/RAPL/GPU rows + END
```

One script, one round trip, one parser. The far side decides which
plugin's branch runs; our side never needs to know the OS in advance.

### Bourne, not POSIX

The script is written for the 1979 Bourne shell — backticks, `expr`-free,
no `$( )`, no `[[ ]]`, no `!`, no `local`, no `command -v` — because that is
still `/bin/sh` on Solaris 10, IRIX and a few others. The test suite greps
for the forbidden forms and syntax-checks under dash, bash and busybox.

Piping to `sh` on stdin (rather than `ssh host "<script>"`) means the
remote login shell never parses it. Windows has no `sh`; that failure has a
recognisable message, and `probeRemote` retries with the same wire format
spoken by PowerShell (`userland/powershell.ts`).

### The wire

Raw words, never arithmetic: a 32-bit `expr` overflows on a byte count, and
each OS has its own notation anyway. The shell side says
`mem_total=16384 Megabytes` or `boottime={ sec = 1694000000, usec = 1 }`
verbatim; `parse.ts` reads every notation we have met. Full key list and
the row formats: `userland/types.ts`.

`uf=1` first proves a shell ran the script; `END` last proves it finished.
A node missing `END` is marked `truncated` — a wedged mount or a slow box,
not an absence of hardware.

## Plugins

| id | `uname -s` | speaks |
|---|---|---|
| linux-android | Linux (+ `uname -o` Android, /system/build.prop, toybox, getprop) | procfs, toybox ps, getprop |
| linux-busybox | Linux (+ busybox present, ps not procps) | procfs, busybox ps -o |
| linux-gnu | Linux (else) | procfs, sysfs, procps, RAPL, nvidia-smi, rocm-smi |
| gnu-hurd | GNU | procfs translator, Hurd ps |
| freebsd | FreeBSD, MidnightBSD, DragonFly, GNU/kFreeBSD | sysctl, swapinfo, diskinfo -v |
| openbsd | OpenBSD | sysctl (physmem64, hw.disknames), swapctl, top -n |
| netbsd | NetBSD, Minix | sysctl, swapctl, top -b |
| darwin | Darwin | sysctl, vm_stat, diskutil |
| sunos | SunOS (Solaris, illumos, SmartOS, OmniOS, OpenIndiana) | psrinfo, kstat, prtconf, swap -s, diskinfo/iostat -En, xpg4 ps |
| aix | AIX, OS400 (PASE) | prtconf, vmstat, lsps, lsdev |
| hp-ux | HP-UX | machinfo, ioscan, swapinfo, UNIX95 ps |
| irix | IRIX, IRIX64 | hinv, sar -r, swap -s |
| osf1 | OSF1 (Tru64) | psrinfo, vmstat -P, swapon -s, hwmgr |
| sco | UnixWare, SCO_SV | uname -X, psrinfo, memsize, sar -r |
| haiku | Haiku | sysinfo -cpu/-mem |
| qnx | QNX | pidin info |
| cygwin | CYGWIN_NT*, MSYS_NT*, MINGW32_NT*, MINGW64_NT* | procfs emulation, PowerShell/wmic for disks |
| windows-sh | Windows_NT, WindowsNT, "Windows NT" | env vars, then the PowerShell script by here-doc, else wmic |
| windows-powershell | (no sh at all) | CIM/WMI, Get-PhysicalDisk, Get-Process |
| generic | everything else: Interix, OS/390 USS, NonStop, SINIX, ReliantUNIX, ULTRIX, A/UX, SerenityOS, Redox … | getconf, uname -p, uptime, ps -ef; tries sysctl and /proc if present |

Every plugin body must never fail the script and never block: each command
carries `2>/dev/null` or an `if have x`, and the only sleep is RAPL's 0.1s.

### Adding one

1. Add a `plugin(...)` block to the generator (
   `userland/gen-plugins.py`, then `make userland-plugins`) or write `plugins/<id>.ts` by hand — a
   `Userland` with `sysnames`, optional `refine`, and a Bourne `body`.
2. Register it in `registry.ts` in the order detection should try it.
3. Add a fixture to `userland.test.ts` `FIXTURES` — the plugin's output as
   its commands' manuals document it — and, if it introduces a new
   notation, teach `parse.ts` to read it.

## The deep probe

`/api/mesh/node` (the node page) prepends the same userland script as a
`===SECTION:UF===` section, then runs its Linux-only sections. On a
non-Linux box those come back `n/a` and `parseProbeOutput` fills system,
memory, load, uptime and disks from the userland section. Its own Linux
commands fall back where a POSIX equivalent exists (`df -k`, `ps -eo`).

Because the rest of that script needs `$( )`, its first lines hand a 1979
Bourne shell off to a POSIX one. That handoff is only safe on a shell that
reads its pipe one byte at a time — dash reads ahead and lands mid-buffer —
so it is gated on a Bourne tell: old Bourne does not expand `~`.

## What still cannot be reached

- An sshd whose crypto the local client refuses (SSH-1, `ssh-rsa`
  signatures, group1 KEX). Fix is `~/.ssh/config`; the Add Node form says so.
- A machine with neither a Bourne-compatible shell nor PowerShell: Plan 9
  (rc), OpenVMS (DCL). They report `No POSIX shell or PowerShell on remote`.
- Anything that sets a forced command or a restricted shell for the key.
