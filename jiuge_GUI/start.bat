@echo off
setlocal
chcp 65001 >nul
title Jiuge Benchmark GUI
cd /d "%~dp0"

echo Checking dependencies...
if not exist node_modules (
    echo First run, installing dependencies...
    npm install
    if errorlevel 1 (
        echo Install failed. Please check Node.js and npm.
        pause
        exit /b 1
    )
)

echo Starting GUI...
npm start
