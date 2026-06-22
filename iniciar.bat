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
echo  ================================================================
echo   Servidor local iniciando na porta %PORT%
echo  ----------------------------------------------------------------
echo   Nesta maquina:   http://localhost:%PORT%/
echo.
echo   De OUTRAS maquinas na rede, use um destes enderecos IPv4:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo       http://%%a:%PORT%/
echo.
echo   Se outra maquina nao conseguir acessar, execute uma vez o
echo   "liberar-firewall.bat" (botao direito - Executar como administrador).
echo  ================================================================
echo.
echo   Deixe esta janela aberta. Para encerrar, tecle Ctrl+C ou feche-a.
echo.

rem --- Abre o navegador local apos 2s (da tempo do servidor subir) ---
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%/"

rem --- Sobe o servidor escutando em todas as interfaces da rede ---
%PY% -m http.server %PORT% --bind 0.0.0.0
