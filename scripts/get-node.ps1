# Downloads a private copy of Node.js into .\runtime - run once by start.ps1 when this PC has no Node.js 24+.
# Nothing is installed system-wide; deleting the runtime folder removes it.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # Cockpit's folder (this script lives in scripts\)
$runtime = Join-Path $here 'runtime'
$NODE_VERSION = 'v24.13.1'
$Host.UI.RawUI.WindowTitle = 'Getting Cockpit ready'
Write-Host ''
Write-Host '  Getting Cockpit ready - one time only' -ForegroundColor Cyan
Write-Host "  Downloading Node.js $NODE_VERSION (about 30 MB) into this folder. Nothing is installed on Windows."
Write-Host '  This window closes by itself when it is done.'
Write-Host ''
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $zip = Join-Path $env:TEMP "node-$NODE_VERSION-win-x64.zip"
  $ProgressPreference = 'SilentlyContinue'   # the progress bar makes Invoke-WebRequest many times slower
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-win-x64.zip" -OutFile $zip -UseBasicParsing
  Write-Host '  Unpacking...'
  Expand-Archive -Path $zip -DestinationPath $env:TEMP -Force
  if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
  Move-Item (Join-Path $env:TEMP "node-$NODE_VERSION-win-x64") $runtime
  Remove-Item $zip -Force
  Write-Host '  Done.' -ForegroundColor Green
  Start-Sleep -Seconds 1
} catch {
  Write-Host ''
  Write-Host ('  It did not work: ' + $_.Exception.Message) -ForegroundColor Yellow
  Write-Host '  Check the internet connection and start Cockpit again.'
  Read-Host '  Press Enter to close'
}
