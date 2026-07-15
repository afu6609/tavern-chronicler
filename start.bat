@echo off
rem tavern-chronicler bridge launcher (127.0.0.1:9377).
rem Runtime settings live in memory\bridge-config.json and can be changed
rem live from the SillyTavern extension panel; env vars are only fallbacks.
rem NOTE: keep this file ASCII-only -- cmd parses batch files in the OEM
rem codepage (GBK) and UTF-8 comments corrupt the lines that follow them.
title tavern-chronicler bridge (127.0.0.1:9377)
cd /d %~dp0
node server.mjs
echo.
echo Bridge exited.
pause
