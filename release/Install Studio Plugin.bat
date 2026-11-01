@echo off
setlocal
set "SRC=%~dp0SourceMapImporter.rbxmx"
set "DEST=%LOCALAPPDATA%\Roblox\Plugins"

if not exist "%SRC%" (
  echo Couldn't find SourceMapImporter.rbxmx next to this file.
  echo Unzip the whole folder first, then run this again.
  pause
  exit /b 1
)

if not exist "%DEST%" mkdir "%DEST%"
copy /y "%SRC%" "%DEST%\SourceMapImporter.rbxmx" >nul
if errorlevel 1 (
  echo The plugin couldn't be copied to %DEST%
  pause
  exit /b 1
)

echo Plugin installed. Restart Roblox Studio to load it.
pause
