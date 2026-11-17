@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   万能翻唱 · 本地网页应用
echo ============================================
echo.
echo 正在启动后端服务...
echo 浏览器会自动打开 http://127.0.0.1:18321
echo 若首次显示"连接失败"，刷新一下页面即可。
echo.
echo 关闭这个窗口 = 停止服务。
echo ============================================
echo.
start "" http://127.0.0.1:18321
set "NODE=D:\node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" server.mjs
echo.
echo 服务已停止。
pause
