/**
 * LiveKit cho bản web (Safari trên iPhone). Trình duyệt tự khử vọng, khử ồn qua WebRTC.
 */
import { LiveKitRoom, RoomAudioRenderer, useAudioPlayback } from '@livekit/components-react';
import type { LocalAudioTrack, RemoteAudioTrack, RoomOptions } from 'livekit-client';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text } from 'react-native';

import type { RoomProps } from './livekit';
import { styles } from './ui';

export { useLocalParticipant, useRoomContext, useVoiceAssistant } from '@livekit/components-react';
export type { RoomProps };

/**
 * Bộ đệm trước khi agent vào phòng: micro thu ngay lúc kết nối, agent vào (mất vài giây)
 * thì nhận lại phần đã nói, nên app hiện "đang nghe" luôn. Agent chỉ giải mã được Opus;
 * trình duyệt nào MediaRecorder không ghi được webm/opus thì thôi (chờ agent như native).
 */
export const PRECONNECT_BUFFER =
  typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus');

// Cả phiên dùng chung một AudioContext: phát giọng Ginger (qua GainNode để chỉnh được âm
// lượng; Safari iOS bỏ qua audio.volume) và đo âm lượng micro.
let audioCtx: AudioContext | null = null;

/** Gọi ngay trong lần chạm mic: Safari chỉ cho AudioContext chạy nếu tạo/resume lúc người dùng chạm. */
export async function startAudio(): Promise<void> {
  audioCtx ??= new AudioContext();
  await audioCtx.resume();
}

export function stopAudio(): void {}

/** Âm lượng RMS (0..1, tuyến tính, cùng thang với bản native) của một track. */
export function useAudioLevel(track: LocalAudioTrack | RemoteAudioTrack | undefined): number {
  const [level, setLevel] = useState(0);
  const mediaTrack = track?.mediaStreamTrack;
  useEffect(() => {
    const ctx = audioCtx;
    if (!mediaTrack || !ctx) return;
    const source = ctx.createMediaStreamSource(new MediaStream([mediaTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const id = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      setLevel(Math.sqrt(sum / buf.length));
    }, 1000 / 30);
    return () => {
      clearInterval(id);
      source.disconnect();
    };
  }, [mediaTrack]);
  return level;
}

export function Room({ children, ...props }: RoomProps) {
  const options = useMemo<RoomOptions>(
    () => ({
      webAudioMix: audioCtx ? { audioContext: audioCtx } : true,
      publishDefaults: { preConnectBuffer: PRECONNECT_BUFFER },
    }),
    [],
  );
  return (
    <LiveKitRoom
      {...props}
      options={options}
      connect
      audio={{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }}
      video={false}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: '100%' }}
    >
      {children}
      {/* Phát giọng Ginger: trên web phải có thẻ audio thật trong trang. */}
      <RoomAudioRenderer />
      <UnlockAudio />
    </LiveKitRoom>
  );
}

/** Trình duyệt chặn tự phát âm thanh: hiện nút để anh chạm một lần cho phép. */
function UnlockAudio() {
  const { canPlayAudio, startAudio } = useAudioPlayback();
  if (canPlayAudio) return null;
  return (
    <Pressable onPress={startAudio} style={styles.unlockBtn}>
      <Text style={styles.unlockText}>Chạm để nghe Ginger</Text>
    </Pressable>
  );
}
