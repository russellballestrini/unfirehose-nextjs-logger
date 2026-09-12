/**
 * The same wire format, spoken by PowerShell, for a Windows box whose
 * sshd hands us cmd.exe or pwsh rather than a Bourne shell. Fed on stdin
 * to `powershell -Command -` (Windows PowerShell 2 through 5, and pwsh),
 * and also pasted into a here-doc by the windows-sh plugin when a Bourne
 * shell on Windows finds powershell on PATH.
 *
 * Get-CimInstance is 3.0+; Get-WmiObject is the 2.0 fallback. Neither
 * may exist on a Nano/Core image, hence the SilentlyContinue everywhere.
 */
export const POWERSHELL_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
function cim($c) { if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { Get-CimInstance -ClassName $c } else { Get-WmiObject -Class $c } }
function epoch($d) { [int64](($d.ToUniversalTime() - (Get-Date '1970-01-01 00:00:00Z').ToUniversalTime()).TotalSeconds) }
'uf=1'
'os=Windows_NT'
'userland=windows-powershell'
"hostname=$env:COMPUTERNAME"
"now=$(epoch (Get-Date))"
$os = cim Win32_OperatingSystem
"osrel=$($os.Caption) $($os.Version)"
$cpus = @(cim Win32_Processor)
"cpu=$($cpus[0].Name)"
"nproc=$(($cpus | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)"
"arch=$env:PROCESSOR_ARCHITECTURE"
"mem_total=$($os.TotalVisibleMemorySize) kB"
"mem_avail=$($os.FreePhysicalMemory) kB"
$pf = @(cim Win32_PageFileUsage)
if ($pf.Count -gt 0) {
  "swap_total=$(($pf | Measure-Object -Property AllocatedBaseSize -Sum).Sum) MB"
  "swap_used=$(($pf | Measure-Object -Property CurrentUsage -Sum).Sum) MB"
}
$boot = $os.LastBootUpTime
if ($boot -is [string]) { $boot = [Management.ManagementDateTimeConverter]::ToDateTime($boot) }
if ($boot) { "uptime_s=$([int64]((Get-Date) - $boot).TotalSeconds)" }
$lp = ($cpus | Measure-Object -Property LoadPercentage -Average).Average
if ($lp -ne $null) { $l = [math]::Round($lp / 100 * (($cpus | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum), 2); "load=$l $l $l" }
$pd = @(Get-PhysicalDisk)
if ($pd.Count -gt 0) {
  foreach ($d in $pd) { $r = '?'; if ($d.MediaType -eq 'SSD') { $r = 0 } elseif ($d.MediaType -eq 'HDD') { $r = 1 }; "DISK $($d.FriendlyName -replace ' ', '_') $r" }
} else {
  foreach ($d in @(cim Win32_DiskDrive)) { "DISK disk$($d.Index) ?" }
}
$tot = [double]$os.TotalVisibleMemorySize
foreach ($p in Get-Process) {
  $rss = [int64]($p.WorkingSet64 / 1024); $vsz = [int64]($p.VirtualMemorySize64 / 1024)
  $pm = if ($tot -gt 0) { [math]::Round($rss / $tot * 100, 1) } else { 0 }
  $cmd = if ($p.Path) { $p.Path } else { $p.ProcessName }
  "HPROC - $($p.Id) 0.0 $pm $vsz $rss ? R - 0:00 $cmd"
}
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { nvidia-smi --query-gpu=power.draw,name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits | ForEach-Object { "GPU $_" } }
'END'
`;
