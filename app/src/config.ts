/**
 * Địa chỉ backend và token cho app native.
 * - Dev build (JS chạy từ Metro trên máy): cả hai lấy từ app/.env.
 * - Bản preview/App Store (JS đóng gói trên EAS): API_URL lấy từ biến môi trường của EAS;
 *   token không đóng gói vào app, anh nhập một lần (TokenGate), lưu trong Keychain.
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';

const KEY = 'ginger.appToken';

// Nạp khi cần: dev build cũ chưa có module native này (và có sẵn token nên không cần tới).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const secureStore = (): typeof import('expo-secure-store') => require('expo-secure-store');
let token = process.env.EXPO_PUBLIC_APP_TOKEN ?? '';

/** Đọc token đã lưu (gọi một lần lúc mở app, trước getAppToken). */
export async function loadAppToken(): Promise<void> {
  if (token) return;
  try {
    token = (await secureStore().getItemAsync(KEY)) ?? '';
  } catch {
    token = '';
  }
}

export function getAppToken(): string {
  return token;
}

export function setAppToken(value: string): void {
  token = value;
  try {
    secureStore().setItemAsync(KEY, value).catch(() => {});
  } catch {
    // Không có Keychain: chỉ nhớ token tới khi tắt app.
  }
}
