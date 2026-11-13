/**
 * Bản web do chính backend phục vụ (cùng địa chỉ) nên gọi API bằng đường dẫn tương đối.
 * Token không đóng gói vào bản web (ai mở được trang là đọc được): anh nhập một lần,
 * trình duyệt lưu lại.
 */
export const API_URL = '';

const KEY = 'ginger.appToken';

/** Bản native đọc Keychain bất đồng bộ; web đọc localStorage được ngay. */
export async function loadAppToken(): Promise<void> {}

export function getAppToken(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAppToken(token: string): void {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // Safari riêng tư có thể chặn localStorage: chỉ nhớ token tới khi đóng trang.
  }
}
