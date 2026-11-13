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

const DEVICE_KEY = 'ginger.deviceId';
let deviceId = '';

/** Mã thiết bị của trình duyệt này (tài khoản riêng), lưu localStorage. */
export async function loadDeviceId(): Promise<void> {
  if (deviceId) return;
  try {
    deviceId = localStorage.getItem(DEVICE_KEY) ?? '';
  } catch {
    deviceId = '';
  }
  if (deviceId) return;
  deviceId = crypto.randomUUID();
  try {
    localStorage.setItem(DEVICE_KEY, deviceId);
  } catch {
    // Safari riêng tư: mã chỉ dùng tới khi đóng trang.
  }
}

export function getDeviceId(): string {
  return deviceId;
}
