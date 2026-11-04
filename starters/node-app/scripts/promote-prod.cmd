@echo off
rem {{TITLE}} - promote main to PROD and read it back (scripts\promote.js does the work: fast-forward, migrate, restart, SMOKE, restore on failure)
node "%~dp0promote.js"
pause
