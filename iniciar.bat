@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PORT=8000"

rem --- Detecta o Python (python ou py) ---
set "PY=python"
where python >nul 2>nul
if errorlevel 1 (
  set "PY=py"
  where py >nul 2>nul
  if errorlevel 1 (
    echo.
    echo  [ERRO] Python nao encontrado.
    echo  Instale em https://www.python.org/downloads/ e marque "Add Python to PATH".
    echo.
    pause
    exit /b 1
  )
)

echo.
echo  Iniciando o servidor local em http://localhost:%PORT%
echo  Abrindo o navegador... (deixe esta janela aberta enquanto usa o programa)
echo  Para encerrar, feche esta janela ou tecle Ctrl+C.
echo.

rem --- Abre o navegador apos 2s (da tempo do servidor subir) ---
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%/"

rem --- Sobe o servidor (fica rodando nesta janela) ---
%PY% -m http.server %PORT%
