#!/usr/bin/env bash
# Build app iOS bản App Store/TestFlight ngay trên máy Mac (không tốn lượt build EAS), rồi gửi lên
# App Store Connect.
#
#   bash scripts/build-ios.sh            # pull code, build .ipa, kiểm tra, hỏi có submit không
#   bash scripts/build-ios.sh --submit   # build xong submit luôn
#   bash scripts/build-ios.sh --no-pull  # build đúng code đang có, không git pull
#
# Cần cài một lần trên Mac: Xcode (mở một lần để cài thêm thành phần, nhận license),
# `brew install node cocoapods fastlane`, rồi `npx eas-cli login` (hoặc export EXPO_TOKEN).
# Lần đầu EAS hỏi đăng nhập Apple để tạo provisioning profile App Store; lần submit đầu hỏi
# App Store Connect API key (EAS tạo giúp được). Các lần sau chạy thẳng.
#
# Dùng `eas build --local`, không build bằng Xcode tay: EAS copy project theo .gitignore nên bỏ
# app/.env, và lấy EXPO_PUBLIC_API_URL từ môi trường EAS `preview`. Build bằng Xcode thì Metro
# đọc app/.env và nhúng EXPO_PUBLIC_APP_TOKEN vào app. Script vẫn soi .ipa trước khi submit.
# Profile `production` dùng channel `preview`: bản OTA (`scripts/ota.sh`) tới cả app TestFlight.
set -euo pipefail
cd "$(dirname "$0")/.."

submit=ask pull=1
for a in "$@"; do
  case "$a" in
    --submit) submit=yes ;;
    --no-submit) submit=no ;;
    --no-pull) pull=0 ;;
    *) echo "Không hiểu tham số: $a" >&2; exit 2 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
[ "$(uname)" = Darwin ] || die "Script này chạy trên macOS."
for t in xcodebuild pod fastlane node npx git unzip; do
  command -v "$t" >/dev/null || die "Thiếu $t (xem phần cần cài ở đầu script)."
done
xcodebuild -version >/dev/null 2>&1 || die "Xcode chưa sẵn sàng: chạy 'sudo xcode-select -s /Applications/Xcode.app' và mở Xcode một lần."

if [ "$pull" = 1 ]; then
  [ -z "$(git status --porcelain)" ] || die "Có thay đổi chưa commit; commit/stash trước hoặc chạy --no-pull."
  git pull --ff-only
fi
npm ci
npx eas-cli whoami >/dev/null 2>&1 || die "Chưa đăng nhập Expo: chạy 'npx eas-cli login'."

export EXPO_NO_DOTENV=1
out_dir="$HOME/ginger-ipa"  # ngoài repo: thêm vào .gitignore sẽ đổi fingerprint (runtimeVersion)
mkdir -p "$out_dir"
ipa="$out_dir/Ginger-$(git rev-parse --short HEAD).ipa"
npx eas-cli build --platform ios --profile production --local --output "$ipa"

# Soi bundle JS trong .ipa: phải có địa chỉ backend, không được có APP_TOKEN.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
unzip -q "$ipa" 'Payload/*.app/main.jsbundle' -d "$tmp"
bundle=$(find "$tmp" -name main.jsbundle | head -n1)
[ -n "$bundle" ] || die "Không thấy main.jsbundle trong $ipa."
token=$(grep '^EXPO_PUBLIC_APP_TOKEN=' .env 2>/dev/null | cut -d= -f2- || true)
if [ -n "$token" ] && grep -qaF -- "$token" "$bundle"; then
  rm -f "$ipa"; die "Bản build có APP_TOKEN, đã xoá .ipa, không submit."
fi
api_url=$(npx eas-cli env:exec preview 'printf "%s" "$EXPO_PUBLIC_API_URL"' --non-interactive 2>/dev/null | tail -n1)
[ -n "$api_url" ] && grep -qaF -- "$api_url" "$bundle" || die "Bản build thiếu EXPO_PUBLIC_API_URL, không submit."
echo "✓ Đã kiểm tra: $ipa có địa chỉ backend, không có APP_TOKEN."

if [ "$submit" = ask ]; then
  read -r -p "Gửi lên App Store Connect (TestFlight) luôn? [y/N] " r
  [[ "$r" =~ ^[yY]$ ]] && submit=yes || submit=no
fi
if [ "$submit" = yes ]; then
  npx eas-cli submit --platform ios --profile production --path "$ipa"
  echo "✓ Đã gửi. Apple xử lý vài phút tới vài chục phút rồi bản build hiện trong TestFlight."
else
  echo "Để gửi sau: npx eas-cli submit --platform ios --profile production --path $ipa"
fi
