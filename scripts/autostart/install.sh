#!/usr/bin/env bash
# Cài tự khởi động cho backend + agent + worker trình duyệt sau khi bật máy (chạy một lần, trong WSL):
#
#   bash scripts/autostart/install.sh
#
# Chuỗi khởi động sau khi cài:
#   Windows đăng nhập → Docker Desktop tự mở → Postgres lên (restart: unless-stopped)
#                     → task "Ginger" (Task Scheduler) giữ WSL chạy + cập nhật portproxy 8000 → IP WSL
#   WSL bật → systemd user (linger) chạy ginger-backend + ginger-agent + ginger-browser, chết thì tự chạy lại
#   Tailscale Funnel tự giữ cấu hình, không cần làm gì.
#
# Lệnh hằng ngày:
#   systemctl --user status ginger-backend ginger-agent ginger-browser
#   systemctl --user restart ginger-agent      # sau khi sửa agent.py (agent không tự nạp lại)
#   systemctl --user restart ginger-browser    # sau khi sửa browser.py
#   journalctl --user -u ginger-agent -f       # xem log
#   systemctl --user stop ginger-backend ginger-agent   # muốn tự chạy tay trong terminal
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
be="$repo/backend"
[ -x "$be/.venv/bin/uvicorn" ] || { echo "Chưa có $be/.venv" >&2; exit 1; }
[ -f "$be/.env" ] || { echo "Chưa có $be/.env" >&2; exit 1; }

# 1. Dịch vụ systemd của user (ghi đường dẫn thật vào ~/.config, không nằm trong repo).
units="$HOME/.config/systemd/user"
mkdir -p "$units"
cat > "$units/ginger-backend.service" <<EOF
[Unit]
Description=Ginger backend (FastAPI, cổng 8000)

[Service]
WorkingDirectory=$be
ExecStart=$be/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
cat > "$units/ginger-agent.service" <<EOF
[Unit]
Description=Ginger agent (LiveKit)

[Service]
WorkingDirectory=$be
ExecStart=/bin/bash -c 'set -a && . ./.env && set +a && exec .venv/bin/python -m app.agent dev'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
cat > "$units/ginger-browser.service" <<EOF
[Unit]
Description=Ginger worker trình duyệt (Gừng thao tác web, app/browser.py)

[Service]
WorkingDirectory=$be
ExecStart=$be/.venv/bin/python -m app.browser
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable ginger-backend ginger-agent ginger-browser

# 2. Linger: dịch vụ user chạy ngay khi WSL bật, không cần mở terminal.
if [ "$(loginctl show-user "$USER" -p Linger --value)" != yes ]; then
  echo "Bật linger (cần mật khẩu sudo):"
  sudo loginctl enable-linger "$USER"
fi

# 3. Postgres + trình duyệt (container) theo restart policy mới.
(cd "$be" && docker.exe compose up -d)

# 4. Phía Windows: task "Ginger" chạy lúc đăng nhập (quyền admin để sửa portproxy).
win_dir=$(wslpath "$(cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')")/Ginger
mkdir -p "$win_dir"
cp "$repo/scripts/autostart/windows-logon.ps1" "$repo/scripts/autostart/register-task.ps1" "$win_dir/"
echo "Đăng ký task Windows: bấm Yes ở hộp thoại UAC."
powershell.exe -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$(wslpath -w "$win_dir/register-task.ps1")','-Distro','$WSL_DISTRO_NAME'"

systemctl --user restart ginger-backend ginger-agent ginger-browser
sleep 3
systemctl --user --no-pager status ginger-backend ginger-agent ginger-browser | grep -E '●|Active:'
