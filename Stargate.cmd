@echo off
title STARGATE COMMAND - dialing computer
cd /d "%~dp0"
node server.js %*
