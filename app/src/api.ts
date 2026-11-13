import { fetch } from 'expo/fetch';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';
const APP_TOKEN = process.env.EXPO_PUBLIC_APP_TOKEN ?? '';

const authHeaders = { Authorization: `Bearer ${APP_TOKEN}` };

export type Memory = { id: number; content: string; updated_at: string };

export type VoiceEvent =
  | { type: 'transcript'; text: string }
  | { type: 'reply_delta'; text: string }
  | { type: 'audio'; audio_id: string; index: number }
  /** Âm lượng 0..1 của câu `index`, mỗi giá trị là một khung 50 ms, bắt đầu từ khung `start`. */
  | { type: 'level'; index: number; start: number; values: number[] }
  | { type: 'reply'; text: string; conversation_id: string; audio_count: number }
  | { type: 'error'; message: string };

type PcmChunk = { data: ArrayBuffer; sampleRate: number; channels: number };

/**
 * Một lượt hold-to-talk trên một WebSocket tới backend.
 * Mở ngay khi bấm nút; audio thu được trước khi kết nối xong sẽ được xếp hàng chờ.
 */
export class VoiceSession {
  private ws: WebSocket;
  private queue: (string | ArrayBuffer)[] = [];
  private started = false;
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
      headers: authHeaders,
    });
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      for (const m of this.queue) this.ws.send(m);
      this.queue = [];
    };
    this.ws.onmessage = (e) => {
      const event = JSON.parse(String(e.data)) as VoiceEvent;
      if (event.type === 'reply' || event.type === 'error') this.done = true;
      this.onEvent(event);
    };
    this.ws.onclose = () => {
      if (!this.done) {
        this.done = true;
        this.onEvent({ type: 'error', message: 'Mất kết nối tới server' });
      }
    };
  }

  private send(m: string | ArrayBuffer) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(m);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(m);
  }

  /** PCM int16 từ micro. Gói đầu tiên kèm cấu hình thật (sample rate có thể khác yêu cầu). */
  sendAudio(chunk: PcmChunk) {
    if (!this.started) {
      this.started = true;
      this.send(
        JSON.stringify({
          type: 'start',
          sample_rate: chunk.sampleRate,
          channels: chunk.channels,
          conversation_id: this.conversationId,
        }),
      );
    }
    this.send(chunk.data);
  }

  /** Thả nút: báo hết audio, chờ server trả transcript và câu trả lời. */
  end() {
    this.send(JSON.stringify({ type: 'end' }));
  }

  /** Bỏ lượt này (bấm quá ngắn). */
  cancel() {
    this.done = true;
    this.send(JSON.stringify({ type: 'cancel' }));
    this.ws.close();
  }
}

export function voiceAudioSource(audioId: string) {
  return { uri: `${API_URL}/voice/audio/${audioId}`, headers: authHeaders };
}

export async function getMemories(): Promise<Memory[]> {
  const res = await fetch(`${API_URL}/memories`, { headers: authHeaders });
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
  return (await res.json()) as Memory[];
}

export async function deleteMemory(id: number): Promise<void> {
  const res = await fetch(`${API_URL}/memories/${id}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  if (!res.ok) throw new Error(`Lỗi server ${res.status}`);
}
