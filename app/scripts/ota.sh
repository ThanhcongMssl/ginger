#!/usr/bin/env bash
# Đẩy bản JS mới cho app preview đã cài (EAS Update), không cần build lại.
# Chỉ dùng khi đổi code JS/TS; thêm thư viện native hay đổi app.json phần native thì phải build.
#
#   bash scripts/ota.sh "Mô tả thay đổi"   (chạy trong app/)
#
# Không chạy thẳng `eas update`: nó đóng gói bằng `expo export` trên máy, đọc cả app/.env nên sẽ
# nhúng EXPO_PUBLIC_APP_TOKEN vào bản update. Ở đây tắt .env, lấy biến từ môi trường EAS `preview`
# (chỉ có EXPO_PUBLIC_API_URL), đóng gói riêng rồi kiểm tra không có token mới tải lên.
set -euo pipefail
cd "$(dirname "$0")/.."

msg="${1:?Cần mô tả thay đổi: bash scripts/ota.sh \"...\"}"
# Ngoài thư mục app: thêm vào .gitignore sẽ đổi fingerprint (runtimeVersion) của app.
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
export EXPO_NO_DOTENV=1

# runtimeVersion theo fingerprint (phần native + app.json + scripts trong package.json + .gitignore).
# Phải khớp một bản app đang cài thì bản update mới tới được: build preview mới nhất trên EAS, hoặc
# bản TestFlight mới nhất build trên Mac (scripts/build-ios.sh, .ipa trong ~/ginger-ipa; build local
# không có runtime trong `eas build:list`, nên đọc file EXUpdates.bundle/fingerprint trong .ipa).
local_rt=$(npx expo-updates runtimeversion:resolve --platform ios 2>/dev/null | tail -n1 \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["runtimeVersion"])')
build_rt=$(npx eas-cli build:list --profile preview --platform ios --status finished --limit 1 \
  --json --non-interactive 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["runtime"]["version"])')
ipa=$(ls -t "$HOME"/ginger-ipa/*.ipa 2>/dev/null | head -n1 || true)
ipa_rt=$([ -n "$ipa" ] && unzip -p "$ipa" 'Payload/*.app/EXUpdates.bundle/fingerprint' 2>/dev/null || true)
if [ "$local_rt" = "$build_rt" ]; then
  echo "✓ Khớp build preview mới nhất ($build_rt)."
elif [ "$local_rt" = "$ipa_rt" ]; then
  echo "✓ Khớp bản TestFlight mới nhất $(basename "$ipa") ($ipa_rt)."
else
  echo "runtimeVersion $local_rt khác build preview ($build_rt) và bản TestFlight mới nhất (${ipa_rt:-không có}):" \
    "đã đổi phần native, phải build lại." >&2
  exit 1
fi

npx eas-cli env:exec preview "npx expo export -p ios --output-dir $out" --non-interactive

token=$(grep '^EXPO_PUBLIC_APP_TOKEN=' .env 2>/dev/null | cut -d= -f2- || true)
if [ -n "$token" ] && grep -rqaF -- "$token" "$out"; then
  echo "Bản đóng gói có APP_TOKEN, dừng lại không tải lên." >&2
  exit 1
fi
api_url=$(npx eas-cli env:exec preview 'printf "%s" "$EXPO_PUBLIC_API_URL"' --non-interactive 2>/dev/null | tail -n1)
if [ -z "$api_url" ] || ! grep -rqaF -- "$api_url" "$out"; then
  echo "Bản đóng gói thiếu EXPO_PUBLIC_API_URL, dừng lại." >&2
  exit 1
fi

npx eas-cli update --channel preview --environment preview --platform ios \
  --skip-bundler --input-dir "$out" --message "$msg" --non-interactive
