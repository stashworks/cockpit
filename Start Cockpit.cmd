@echo off
rem Starts Cockpit in the background and opens it in your browser. Nothing stays open here: this window closes by itself.
rem The first time, the browser opens on the setup wizard. Stop Cockpit from Settings in the browser, or with
rem "Stop Cockpit.cmd". (scripts\start.ps1 does the work.)
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\start.ps1"
