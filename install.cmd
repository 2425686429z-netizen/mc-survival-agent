@echo off
rem 安装依赖（在脚本所在目录执行）
cd /d "%~dp0"
call npm install --no-audit --no-fund
if errorlevel 1 goto fail
echo.
echo 检查协议支持情况：
node -e "const mc=require('minecraft-protocol');console.log('supported versions:',mc.supportedVersions.length);console.log('latest:',mc.supportedVersions.slice(-5).join(' '))"
goto end

:fail
echo npm install 失败。国内网络可改用镜像：
echo   npm install --registry=https://registry.npmmirror.com

:end
pause
