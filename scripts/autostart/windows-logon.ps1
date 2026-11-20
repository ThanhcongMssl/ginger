# Chạy lúc đăng nhập Windows (task "Ginger", quyền admin):
# 1. Bật WSL và giữ nó chạy (không có phiên nào mở thì WSL tự tắt, kéo theo backend + agent).
# 2. IP của WSL đổi sau mỗi lần khởi động lại: trỏ portproxy 8000 (Funnel → 127.0.0.1:8000) sang IP mới.
param([string]$Distro = 'Ubuntu')
$log = Join-Path $PSScriptRoot 'logon.log'
"$(Get-Date -Format s) bắt đầu" | Out-File $log -Encoding utf8

Start-Process wsl.exe -WindowStyle Hidden -ArgumentList '-d', $Distro, '--exec', 'sleep', 'infinity'

$ip = $null
foreach ($i in 1..30) {
  $out = (wsl.exe -d $Distro --exec hostname -I 2>$null) -join ' '
  $ip = ($out.Trim() -split '\s+')[0]
  if ($ip -match '^\d+\.\d+\.\d+\.\d+$') { break }
  $ip = $null; Start-Sleep 2
}
if (-not $ip) { "$(Get-Date -Format s) không lấy được IP WSL" | Out-File $log -Append -Encoding utf8; exit 1 }

netsh interface portproxy delete v4tov4 listenport=8000 listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=8000 listenaddress=0.0.0.0 connectport=8000 connectaddress=$ip
"$(Get-Date -Format s) portproxy 8000 → $ip" | Out-File $log -Append -Encoding utf8
