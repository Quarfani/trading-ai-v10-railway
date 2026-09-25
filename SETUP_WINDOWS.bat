@echo off
chcp 65001 >nul
echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║          Trading AI — الإعداد الأول                  ║
echo ║          شغّل هذا الملف مرة واحدة فقط               ║
echo ╚══════════════════════════════════════════════════════╝
echo.

echo [1/4] التحقق من Python...
python --version >nul 2>&1
if errorlevel 1 (
    py --version >nul 2>&1
    if errorlevel 1 (
        echo ❌ Python غير مثبت!
        echo حمّل Python من: https://python.org/downloads
        echo تأكد من وضع علامة على "Add Python to PATH"
        pause
        exit /b 1
    )
    set PYTHON=py
) else (
    set PYTHON=python
)
echo ✓ Python موجود

echo.
echo [2/4] التحقق من Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js غير مثبت!
    echo حمّل Node.js من: https://nodejs.org
    pause
    exit /b 1
)
echo ✓ Node.js موجود

echo.
echo [3/4] تثبيت مكتبات Python...
cd pipeline
%PYTHON% -m venv venv
call venv\Scripts\activate.bat
%PYTHON% -m pip install -r requirements.txt
if errorlevel 1 (
    echo ❌ فشل تثبيت مكتبات Python
    pause
    exit /b 1
)
echo ✓ مكتبات Python جاهزة
cd ..

echo.
echo [4/4] تثبيت مكتبات Node.js...
cd bot\backend
npm install
if errorlevel 1 (
    echo ❌ فشل تثبيت مكتبات Bot
    pause
    exit /b 1
)
cd ..

cd frontend
npm install
if errorlevel 1 (
    echo ❌ فشل تثبيت مكتبات Dashboard
    pause
    exit /b 1
)
cd ..\..

echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║  ✅ الإعداد اكتمل بنجاح!                            ║
echo ║                                                      ║
echo ║  الخطوة التالية:                                     ║
echo ║  1. شغّل DOWNLOAD_DATA.bat لتحميل البيانات          ║
echo ║     (مرة واحدة - يأخذ 30-90 دقيقة)                 ║
echo ║  2. ثم شغّل START.bat لتشغيل البوت                  ║
echo ╚══════════════════════════════════════════════════════╝
echo.
pause
