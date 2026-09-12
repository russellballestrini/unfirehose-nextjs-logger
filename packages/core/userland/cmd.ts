/**
 * The wire from cmd.exe, for a Windows with a third-party sshd and no
 * PowerShell — XP and 2003 with Bitvise or OpenSSH-for-Windows, or a box
 * where PowerShell is disabled by policy. `cmd` with no /c reads commands
 * from stdin one line at a time; `@echo off` first stops it echoing the
 * prompt and each line. Interactive `for` wants `%a`, not the batch `%%a`.
 *
 * wmic prints `Name=value` with CRLF; `for /f "tokens=1* delims=="` splits
 * on the first `=`, and a stray CR that survives is whitespace to the
 * parser. Whatever else cmd prints is not a key and is ignored.
 */
const W = (cls: string, prop: string, key: string, unit = '') =>
  `for /f "tokens=1* delims==" %a in ('wmic ${cls} get ${prop} /value 2^>nul ^| findstr /b ${prop}') do @echo ${key}=%b${unit ? ' ' + unit : ''}`;

export const CMD_SCRIPT = [
  '@echo off',
  'echo uf=1',
  'echo os=Windows_NT',
  'echo userland=windows-cmd',
  'echo hostname=%COMPUTERNAME%',
  'echo nproc=%NUMBER_OF_PROCESSORS%',
  'echo arch=%PROCESSOR_ARCHITECTURE%',
  'echo cpu=%PROCESSOR_IDENTIFIER%',
  W('cpu', 'Name', 'cpu'),
  W('os', 'Caption', 'osrel'),
  W('os', 'TotalVisibleMemorySize', 'mem_total', 'kB'),
  W('os', 'FreePhysicalMemory', 'mem_avail', 'kB'),
  W('os', 'LastBootUpTime', 'boottime'),
  W('pagefile', 'AllocatedBaseSize', 'swap_total', 'MB'),
  W('pagefile', 'CurrentUsage', 'swap_used', 'MB'),
  W('cpu', 'LoadPercentage', 'cpu_pct'),
  `for /f "tokens=1* delims==" %a in ('wmic diskdrive get Index /value 2^>nul ^| findstr /b Index') do @echo DISK disk%b ?`,
  'echo END',
  'exit',
  '',
].join('\r\n');
