@echo off
rem Stops Cockpit (it runs in the background, with no window of its own). The same as Settings - Stop Cockpit.
rem It leaves the file run\stopped first, so the watchdog that restarts Cockpit after a crash knows this stop is on
rem purpose and does not start it again. "Start Cockpit" (or signing in to Windows) clears it.
if not exist "%~dp0run" mkdir "%~dp0run"
echo stopped from Stop Cockpit.cmd> "%~dp0run\stopped"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$f = '%~dp0run\engine.json'; try { $e = Get-Content $f -Raw | ConvertFrom-Json } catch { $e = $null }; try { Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 5 -Headers @{ 'sec-fetch-site' = 'same-origin' } -ContentType 'application/json' -Body '{}' ($e.url + '/api/engine/stop') | Out-Null; Write-Host 'Cockpit stopped.' } catch { $p = if ($e -and $e.pid) { Get-Process -Id $e.pid -ErrorAction SilentlyContinue } else { $null }; if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force; Write-Host 'Cockpit was not answering - stopped.' } else { Write-Host 'Cockpit is not running.' } }; Start-Sleep -Seconds 2"
