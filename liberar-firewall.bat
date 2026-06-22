@echo off
chcp 65001 >nul
set "PORT=8000"

rem --- Precisa ser executado como Administrador ---
net session >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERRO] Execute este arquivo como ADMINISTRADOR.
  echo  Clique com o botao direito em "liberar-firewall.bat" e escolha
  echo  "Executar como administrador".
  echo.
  pause
  exit /b 1
)

echo.
echo  Liberando a porta %PORT% (TCP) no Firewall do Windows para a rede local...
netsh advfirewall firewall delete rule name="Relatorio HTTP %PORT%" >nul 2>nul
netsh advfirewall firewall add rule name="Relatorio HTTP %PORT%" dir=in action=allow protocol=TCP localport=%PORT%

echo.
echo  Pronto. Agora outras maquinas da rede podem acessar
echo  http://SEU_IP:%PORT%/  (descubra SEU_IP rodando o iniciar.bat).
echo.
echo  Para REMOVER esta liberacao depois, rode (como admin):
echo     netsh advfirewall firewall delete rule name="Relatorio HTTP %PORT%"
echo.
pause
