import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

import { registerPushToken } from './api';

// Nạp lười: build cũ chưa có expo-notifications thì bỏ qua thay vì lỗi lúc mở app.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const notifications = (): typeof import('expo-notifications') => require('expo-notifications');

// Đang trong cuộc trò chuyện bằng giọng thì Gừng tự đọc kết quả: không hiện thêm thông báo.
// Backend luôn gửi thông báo cho mọi kết quả (không đoán được app đã ra nền chưa: iOS treo app ngay
// nên LiveKit còn thấy micro thêm tới ~20s); app ra nền thì iOS hiện, không qua hàm này.
let voiceActive = false;
export function setVoiceActive(active: boolean): void {
  voiceActive = active;
}

/**
 * Xin quyền thông báo và gửi Expo push token lên backend (backend/app/push.py). Việc Gừng làm nền
 * (trình duyệt, sửa code) xong mà app đang tắt thì có thông báo; chạm vào là app mở và Gừng đọc kết quả.
 */
export async function setupPush(): Promise<void> {
  // Web không cần; Expo Go không nhận push từ dịch vụ của mình.
  if (Platform.OS === 'web' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return;
  try {
    const N = notifications();
    // Đang mở app mà không trò chuyện (vd. chế độ gõ chữ, chưa tự hiện kết quả) thì vẫn hiện banner.
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: !voiceActive,
        shouldShowList: !voiceActive,
        shouldPlaySound: !voiceActive,
        shouldSetBadge: false,
      }),
    });
    let { status } = await N.getPermissionsAsync();
    if (status !== 'granted') ({ status } = await N.requestPermissionsAsync());
    if (status !== 'granted') return;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const { data } = await N.getExpoPushTokenAsync({ projectId });
    await registerPushToken(data);
  } catch {
    // build cũ chưa có expo-notifications, simulator, hoặc chưa cấu hình APNs: bỏ qua
  }
}
