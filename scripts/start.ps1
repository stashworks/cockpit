# Starts Cockpit in the background and opens it in your browser - run by "Start Cockpit.cmd" (double-click it).
#   - already running: just opens the browser at it
#   - no Node.js 24+ on this PC: a small window downloads a private copy into .\runtime once (nothing installed
#     system-wide), then closes
#   - the engine runs hidden, with no window at all, under a small WATCHDOG (this same script with -Watch) that starts
#     it again if it ever stops on its own (a crash). What the engine prints goes to logs\engine.log; what the watchdog
#     does goes to logs\watchdog.log.
#   - Stop it from Settings, or with "Stop Cockpit.cmd". Stopping leaves the file run\stopped, and the watchdog never
#     starts an engine while that file is there. Start Cockpit (or signing in to Windows) removes it.
# The first time, the browser opens on the setup wizard.
#
# -Watch      be the watchdog: keep the engine running until it is stopped on purpose. One per Cockpit folder (a second
#             one sees the first and leaves). Windows starts it at sign-in when "Start Cockpit automatically when I sign
#             in" is on (a Scheduled Task for this user only - engine/wizard.js); Start Cockpit starts one too.
# -AtLogon    with -Watch: this is a fresh sign-in, so an old Stop from before the restart no longer applies.
# -NoBrowser  start, but do not open the browser.
param([switch]$NoBrowser, [switch]$Watch, [switch]$AtLogon)
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # Cockpit's folder (this script lives in scripts\)
$runtime = Join-Path $here 'runtime'
$runFile = Join-Path $here 'run\engine.json'
$stopFile = Join-Path $here 'run\stopped'
$logs = Join-Path $here 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
New-Item -ItemType Directory -Force (Join-Path $here 'run') | Out-Null

function Engine-Url { try { return (Get-Content $runFile -Raw -ErrorAction Stop | ConvertFrom-Json).url } catch { return $null } }
function Answers($u) { if (-not $u) { return $false }; try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 ($u + '/api/engine') | Out-Null; return $true } catch { return $false } }
function Tell($text) { Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($text, 'Cockpit') }
function Wlog($text) { try { Add-Content -Path (Join-Path $logs 'watchdog.log') -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $text) } catch { } }

# ---- Node.js 24+: ours in .\runtime, or one already on this PC, or download ours once ----
function Find-Node {
  $n = Join-Path $runtime 'node.exe'
  if (Test-Path $n) { return $n }
  $sys = Get-Command node -ErrorAction SilentlyContinue
  $v = if ($sys) { (& $sys.Source --version) 2>$null } else { '' }
  if ($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) { return $sys.Source }
  Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $here 'scripts\get-node.ps1') + '"') -Wait
  if (Test-Path $n) { return $n }
  return $null
}

if ($Watch) {
  # ================= the watchdog =================
  # one per Cockpit folder: a named lock for this folder; a second watchdog sees it taken and leaves
  $sha = [System.Security.Cryptography.SHA1]::Create()
  $tag = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($here.ToLowerInvariant()))) -replace '-', '').Substring(0, 16)
  $created = $false
  $lock = New-Object System.Threading.Mutex($true, ('Local\CockpitWatchdog_' + $tag), [ref]$created)
  if (-not $created) { exit 0 }
  if ($AtLogon) { Remove-Item $stopFile -ErrorAction SilentlyContinue }   # a new sign-in: a Stop from before the restart is over
  $node = Find-Node
  if (-not $node) { Wlog 'no Node.js 24+ and it could not be downloaded - not started'; exit 1 }
  Wlog ('watchdog started (pid ' + $PID + ', node ' + $node + ')')
  $env:COCKPIT_LOG_FILE = Join-Path $logs 'engine.log'
  $env:COCKPIT_LAUNCHED_BY = 'start.ps1'
  $quick = 0
  while ($true) {
    if (Test-Path $stopFile) { Wlog 'stopped on purpose - the watchdog ends'; break }
    # an engine already answering (started before this watchdog, or moved to another port by the wizard): keep an eye on it
    if (Answers (Engine-Url)) { Start-Sleep -Seconds 10; continue }
    Remove-Item $runFile -ErrorAction SilentlyContinue
    # NO WINDOW AT ALL: node starts without a console of its own, so there is nothing to close by mistake (with Windows
    # Terminal as the default terminal, a "hidden" console could still turn up as a window - and closing it ended Cockpit)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = '"' + (Join-Path $here 'index.js') + '"'
    $psi.WorkingDirectory = $here
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $began = Get-Date
    try { $p = [System.Diagnostics.Process]::Start($psi) } catch { Wlog ('could not start node: ' + $_.Exception.Message); Start-Sleep -Seconds 30; continue }
    Wlog ('engine started, pid ' + $p.Id)
    $p.WaitForExit()
    $code = $p.ExitCode
    if (Test-Path $stopFile) { Wlog ('engine stopped on purpose (exit ' + $code + ') - the watchdog ends'); break }
    # it ended on its own. Exit 0 is the wizard moving it to another port (a new engine is already starting): look again
    # in a moment. Anything else is a crash (logs\crash.log says why): start it again - quickly the first times, slower
    # if it keeps falling over at once, so a broken install does not spin the computer.
    if ($code -eq 0) { Start-Sleep -Seconds 3; continue }
    if (((Get-Date) - $began).TotalSeconds -lt 60) { $quick++ } else { $quick = 0 }
    $wait = [Math]::Min(300, 5 * [Math]::Pow(2, [Math]::Min($quick, 6)))
    Wlog ('engine ended on its own (exit ' + $code + ') - starting it again in ' + $wait + ' s')
    Start-Sleep -Seconds $wait
  }
  $lock.ReleaseMutex()
  exit 0
}

# ================= Start Cockpit (double-clicked) =================
Remove-Item $stopFile -ErrorAction SilentlyContinue   # you asked for it: an earlier Stop no longer applies
$u = Engine-Url
$running = Answers $u
if (-not $running -and -not (Find-Node)) { Tell "Cockpit could not get Node.js, which it needs to run.`n`nCheck the internet connection and try again, or install Node.js 24 LTS from nodejs.org."; exit 1 }

# the watchdog, with no window (conhost --headless runs PowerShell with no console window at all); if one is already
# running for this folder, the new one sees it and leaves at once
$ps = Join-Path $PSHOME 'powershell.exe'
$wargs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $MyInvocation.MyCommand.Path + '" -Watch'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
if (Test-Path $conhost) { Start-Process -FilePath $conhost -ArgumentList ('--headless "' + $ps + '" ' + $wargs) -WindowStyle Hidden }
else { Start-Process -FilePath $ps -ArgumentList $wargs -WindowStyle Hidden }

if ($running) { if (-not $NoBrowser) { Start-Process $u }; exit 0 }

# ---- wait for it (up to a minute), then open the browser ----
for ($i = 0; $i -lt 120; $i++) { $u = Engine-Url; if (Answers $u) { break }; Start-Sleep -Milliseconds 500 }
if (-not (Answers $u)) { Tell "Cockpit did not start.`n`nWhat it said is in:`n$(Join-Path $logs 'engine.log')"; exit 1 }
if (-not $NoBrowser) { Start-Process $u }
