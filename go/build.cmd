@echo off
rem Сборка пульта под Windows: копирует UI внутрь бинарника и собирает .exe
cd /d "%~dp0"
if exist public rmdir /s /q public
xcopy ..\public public\ /E /I /Y >nul
if not exist dist mkdir dist
set GOTOOLCHAIN=local
go build -trimpath -ldflags "-s -w" -o dist\pult.exe .
echo Готово: dist\pult.exe
