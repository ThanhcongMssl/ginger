# Đăng ký task "Ginger" chạy windows-logon.ps1 mỗi lần đăng nhập Windows. install.sh gọi file này
# bằng quyền admin; chạy lại bao nhiêu lần cũng được (ghi đè task cũ).
param([string]$Distro = 'Ubuntu')
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'windows-logon.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Distro $Distro"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'Ginger' -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Force | Out-Null
Write-Host "Đã đăng ký task Ginger. Chạy thử ngay:"
Start-ScheduledTask -TaskName 'Ginger'
Start-Sleep 8
netsh interface portproxy show v4tov4
