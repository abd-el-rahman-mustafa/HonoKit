@echo off
rem Runs the latest HonoKit build with the signed Electron runtime in node_modules.
rem Needed while the app is unsigned: Smart App Control blocks unsigned installers.
rem Build first with: npm run build
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
