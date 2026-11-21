/**
 * Đổi lỗi kỹ thuật (fetch, TLS, LiveKit, mã HTTP) thành câu người dùng hiểu được.
 * Lỗi gốc vẫn ghi ra console để còn tra.
 */
const NETWORK =
  /fetch failed|network|tls|ssl|secure connection|timed? ?out|offline|load failed|failed to fetch|could not connect|connection|websocket|pc connection|signal/i;

export const MSG_NETWORK = 'Mất kết nối, kiểm tra mạng rồi thử lại nhé.';
export const MSG_SERVER = 'Gừng đang gặp trục trặc, thử lại sau một lát nhé.';

export function friendlyError(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (raw) console.warn('[lỗi]', raw);
  const status = /Lỗi server (\d{3})/.exec(raw)?.[1];
  if (status === '401' || status === '403') return 'Mã truy cập không còn đúng.';
  if (status) return MSG_SERVER;
  if (/LiveKit/i.test(raw) && /cấu hình/.test(raw)) return MSG_SERVER;
  if (NETWORK.test(raw)) return MSG_NETWORK;
  return fallback;
}
