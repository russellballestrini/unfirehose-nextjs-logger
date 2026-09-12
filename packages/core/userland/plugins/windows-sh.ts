import type { Userland } from '../types';
import { POWERSHELL_SCRIPT } from '../powershell';


export const WindowsSh: Userland = {
  id: 'windows-sh',
  label: 'Windows (busybox-w32 / UnxUtils sh)',
  sysnames: ['Windows_NT', 'WindowsNT', 'Windows NT'],
  notes: 'A Bourne shell on bare Windows. Hands the same PowerShell script the native path uses to powershell on stdin; falls back to environment + wmic.',
  body: `
  kv hostname "$COMPUTERNAME"
  kv nproc "$NUMBER_OF_PROCESSORS"
  kv cpu "$PROCESSOR_IDENTIFIER"
  kv arch "$PROCESSOR_ARCHITECTURE"
  if have powershell; then
    powershell -NoProfile -NonInteractive -Command - <<'__UF_PS__' 2>/dev/null | tr -d '\\r' | grep -v '^uf=1$' | grep -v '^END$'
` + POWERSHELL_SCRIPT + `
__UF_PS__
  elif have wmic; then
    wmic cpu get Name /value 2>/dev/null | tr -d '\\r' | sed -n 's/^Name=/cpu=/p'
    wmic OS get TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime /value 2>/dev/null | tr -d '\\r' | sed -n 's/^TotalVisibleMemorySize=\\(.*\\)/mem_total=\\1 kB/p; s/^FreePhysicalMemory=\\(.*\\)/mem_avail=\\1 kB/p; s/^LastBootUpTime=/boottime=/p'
    wmic pagefile get AllocatedBaseSize,CurrentUsage /value 2>/dev/null | tr -d '\\r' | sed -n 's/^AllocatedBaseSize=\\(.*\\)/swap_total=\\1 MB/p; s/^CurrentUsage=\\(.*\\)/swap_used=\\1 MB/p'
    wmic diskdrive get Index,MediaType /format:csv 2>/dev/null | tr -d '\\r' | awk -F, 'NR>2 && $2!="" {print "DISK disk" $2, "?"}'
  fi
  nvidia`,
};
