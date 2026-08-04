@echo off
title Forge
cd /d "%~dp0"
rem The data profile is not set here. scripts/dev.mjs reads it from the
rem untracked .forge-profile file, so this launcher stays identical in the
rem development and stable checkouts and pushing one cannot redirect the other.
npm run dev
