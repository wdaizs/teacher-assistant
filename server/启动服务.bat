@echo off
chcp 65001 >nul
title 小学数学教师教学助手 - 后端服务
cd /d %~dp0
if not exist node_modules (
  echo 首次启动，正在安装依赖（需联网，需 1-2 分钟）...
  call "%~dp0..\..\node\node.exe" --version 2>nul || (
    echo 【未检测到 Node.js】，请先安装 Node.js 18+ : https://nodejs.org/
    pause & exit 1
  )
  call npm install
)
echo.
echo ===== 启动后端服务 =====
echo 端口: 8765  (可在 环境变量 PORT 修改)
echo 数据: %~dp0data\db.json
echo 按 Ctrl+C 停止服务
echo.
node server.js
pause
