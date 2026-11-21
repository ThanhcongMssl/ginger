import { fetch } from 'expo/fetch';

import { API_URL, getAppToken, getDeviceId } from './config';

const authHeaders = (token = getAppToken()) => ({
  Authorization: `Bearer ${token}`,
  // Tài khoản theo thiết bị (backend/app/accounts.py).
  'X-Device-Id': getDeviceId(),
});

export type Memory = { id: number; content: string; updated_at: string };

/** Sự kiện của một lượt; `turn` là số lượt app gửi lúc bắt đầu, để bỏ qua sự kiện của lượt cũ. */
export type VoiceEvent = (
  /** Chữ tạm thời trong lúc người dùng đang nói. */
  | { type: 'partial'; text: string }
  | { type: 'transcript'; text: string }
  | { type: 'reply_delta'; text: string }
  | { type: 'audio'; audio_id: string; index: number }
  /** Âm lượng 0..1 của câu `index`, mỗi giá trị là một khung 50 ms, bắt đầu từ khung `start`. */
  | { type: 'level'; index: number; start: number; values: number[] }
  | { type: 'reply'; text: string; conversation_id: string; audio_count: number }
  | { type: 'error'; message: string }
) & { turn: number };

type PcmChunk = { data: ArrayBuffer; sampleRate: number; channels: number };

/**
 * Kết nối WebSocket tới backend cho hội thoại giọng nói.
 * Hold-to-talk: một lượt rồi server đóng. Rảnh tay: nhiều lượt trên cùng kết nối,
 * server tự chốt lượt khi người dùng ngừng nói.
 * Mở ngay khi bấm nút; audio thu được trước khi kết nối xong sẽ được xếp hàng chờ.
 */
export class VoiceSession {
  private ws: WebSocket;
  private queue: (string | ArrayBuffer)[] = [];
  private turn = 0;
  private started = false;
  private handsFree = false;
  private done = false;

  constructor(
    private conversationId: string | null,
    private onEvent: (e: VoiceEvent) => void,
  ) {
    // Type của DOM không có tham số thứ 3, nhưng WebSocket của React Native hỗ trợ headers.
    const RNWebSocket = WebSocket as unknown as new (
      url: string,
      protocols: string | string[] | undefined,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    this.ws = new RNWebSocket(`${API_URL.replace(/^http/, 'ws')}/voice`, undefined, {
      headers: authHeaders(),
    });
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      for (const m of this.queue) this.ws.send(m);
      this.queue = [];
    };
    this.ws.onmessage = (e) => {
      const event = JSON.parse(String(e.data)) as VoiceEvent;
      // Hold-to-talk: server đóng kết nối sau lượt, không phải lỗi.
      if (!this.handsFree && (event.type === 'reply' || event.type === 'error')) this.done = true;
      this.onEvent(event);
    };
    this.ws.onclose = () => {
      if (!this.done) {
        this.done = true;
        this.onEvent({ type: 'error', message: 'Mất kết nối tới server', turn: this.turn });
      }
    };
  }

  private send(m: string | ArrayBuffer) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(m);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(m);
  }

  /** Bắt đầu lượt mới; nếu lượt trước còn đang trả lời thì server bỏ nó (ngắt lời). */
  startTurn(turn: number) {
    this.turn = turn;
    this.started = false;
  }

  /** PCM int16 từ micro. Gói đầu tiên của lượt kèm cấu hình thật (sample rate có thể khác yêu cầu). */
  sendAudio(chunk: PcmChunk) {
    if (!this.started) {
      this.started = true;
      this.send(
        JSON.stringify({
          type: 'start',
          turn: this.turn,
          sample_rate: chunk.sampleRate,
          channels: chunk.channels,
          conversation_id: this.conversationId,
        }),
      );
    }
    this.send(chunk.data);
  }

  /** Chuyển sang rảnh tay: server tự chốt lượt khi ngừng nói và giữ kết nối. */
  setHandsFree() {
    this.handsFree = true;
    this.send(JSON.stringify({ type: 'handsfree' }));
  }

  /** Thả nút: báo hết audio, chờ server trả transcript và câu trả lời. */
  end() {
    this.send(JSON.stringify({ type: 'end' }));
  }

  /** Bỏ hết và đóng kết nối. */
  cancel() {
    this.done = true;
    this.send(JSON.stringify({ type: 'cancel' }));
    this.ws.close();
  }
}

/** Token vào phòng LiveKit mới; backend gọi sẵn agent Gừng vào phòng đó. */
export async function getLiveKitToken(conversationId: string | null): Promise<{ url: string; token: string }> {
  const res = await fetch(`${API_URL}/livekit/token`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId }),
  });
  if (!res.ok) throw new Error(res.status === 503 ? 'Backend chưa cấu hình LiveKit' : `Lỗi server ${res.status}`);
  return (await res.json()) as { url: string; token: string };
}

export function voiceAudioSource(audioId: string) {
  return { uri: `${API_URL}/voice/audio/${audioId}`, headers: authHeaders() };
}

/** Expo push token của máy này, để backend gửi thông báo khi việc chạy nền xong (src/push.ts). */
export async function registerPushToken(token: string): Promise<void> {
  const res = await fetch(`${API_URL}/push/token`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
}

export async function getMemories(): Promise<Memory[]> {
  const res = await fetch(`${API_URL}/memories`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
  return (await res.json()) as Memory[];
}

export async function deleteMemory(id: number): Promise<void> {
  const res = await fetch(`${API_URL}/memories/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
}

/** Kiểm tra token có đúng không (bản web: lúc anh nhập token). */
export async function checkAppToken(token: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/memories`, { headers: authHeaders(token) });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
  return true;
}

export type DataStats = { memories: number; conversations: number };

export async function getDataStats(): Promise<DataStats> {
  const res = await fetch(`${API_URL}/data/stats`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
  return (await res.json()) as DataStats;
}

/** Xoá mọi ký ức dài hạn về người dùng. */
export async function clearMemories(): Promise<void> {
  const res = await fetch(`${API_URL}/memories`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
}

/** Xoá mọi cuộc trò chuyện, kèm tin nhắn và bản tóm tắt. */
export async function clearConversations(): Promise<void> {
  const res = await fetch(`${API_URL}/conversations`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
}

export type ModelFamily = 'haiku' | 'sonnet' | 'opus';
/** `models`: bản mới nhất của từng dòng, backend tự tra (vd. "Claude Opus 5.5"). */
export type AppSettings = {
  model: ModelFamily;
  models: { family: ModelFamily; name: string }[];
  /** Lọc giọng xung quanh ở agent (Krisp); gói free LiveKit chỉ có 100 phút/tháng. */
  voice_isolation: boolean;
};

export async function getSettings(): Promise<AppSettings> {
  const res = await fetch(`${API_URL}/settings`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
  return (await res.json()) as AppSettings;
}

async function putSettings(body: Partial<Pick<AppSettings, 'model' | 'voice_isolation'>>): Promise<void> {
  const res = await fetch(`${API_URL}/settings`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
}

/** Chọn dòng model để trò chuyện; áp dụng từ câu hỏi tiếp theo. */
export function setModel(model: ModelFamily): Promise<void> {
  return putSettings({ model });
}

/** Bật/tắt lọc giọng xung quanh; áp dụng từ lần trò chuyện tiếp theo. */
export function setVoiceIsolation(on: boolean): Promise<void> {
  return putSettings({ voice_isolation: on });
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

/** Tin nhắn của một cuộc trò chuyện (cả lượt nói lẫn lượt gõ). */
export async function getMessages(conversationId: string): Promise<ChatMessage[]> {
  const res = await fetch(`${API_URL}/conversations/${conversationId}/messages`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
  return (await res.json()) as ChatMessage[];
}

/**
 * Gửi tin nhắn chữ, nhận câu trả lời dạng stream: `onDelta` nhận từng đoạn chữ.
 * `onConversationId` nhận ID cuộc trò chuyện ngay khi có header (backend tạo mới nếu
 * `conversationId` là null), trước khi stream xong.
 * `signal` để dừng giữa chừng: backend vẫn lưu phần đã trả lời.
 */
export async function sendChat(
  message: string,
  conversationId: string | null,
  handlers: { onDelta: (text: string) => void; onConversationId: (id: string) => void },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}/chat`, {
    method: 'POST',
    signal,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversation_id: conversationId }),
  });
  if (!res.ok || !res.body) throw new Error(`Lỗi server ${res.status}`);
  const id = res.headers.get('X-Conversation-Id');
  if (id) handlers.onConversationId(id);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) handlers.onDelta(text);
  }
}
