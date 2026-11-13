import type { RemoteAudioTrack } from 'livekit-client';
import { useEffect, useRef } from 'react';

// Micro (đã khử vọng) phải to hơn ồn nền chừng này lần, và không nhỏ hơn MIN_SPEECH_LEVEL
// (RMS 0..1), thì mới coi là anh đang nói.
const OVER_NOISE = 3;
const MIN_SPEECH_LEVEL = 0.04;
// Ồn nền: bám nhanh khi micro nhỏ đi, tăng chậm (~4s) để giọng nói không bị tính là ồn.
// Mấy giây đầu chưa biết ồn nền thì cho tăng nhanh.
const FLOOR_FALL = 0.1;
const FLOOR_RISE = 0.005;
const FLOOR_WARMUP_MS = 1500;
const FLOOR_RISE_WARMUP = 0.1;
// Nói liên tục chừng này mới hạ giọng Ginger (bỏ qua tiếng lạch cạch ngắn).
const ATTACK_MS = 200;
// Im chừng này thì coi như anh đã thôi nói, giọng Ginger to trở lại.
const RELEASE_MS = 800;
// Khoảng lặng giữa các âm tiết ngắn hơn mức này vẫn tính là đang nói.
const GAP_MS = 120;
const DUCK_VOLUME = 0.25;
const FADE_DOWN_MS = 220;
const FADE_UP_MS = 400;
const TICK_MS = 20;

/**
 * Anh vừa nói chen vào là giọng Ginger nhỏ dần ngay trên máy. Server phải chờ nghe ra chữ
 * đầu tiên mới dừng hẳn (để tiếng ồn không làm Ginger dừng); lúc đó giọng đã nhỏ nên không
 * nghe thấy bị cắt cái phụt. Nếu không phải ngắt lời thì giọng Ginger to trở lại.
 */
export function useDucking(agentTrack: RemoteAudioTrack | undefined, micLevel: number) {
  const level = useRef(0);
  useEffect(() => {
    level.current = micLevel;
  }, [micLevel]);

  useEffect(() => {
    if (!agentTrack) return;
    let gain = 1;
    let floor = 0;
    let talking = false;
    let aboveSince: number | null = null;
    let lastAbove = 0;
    const startedAt = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const l = level.current;
      const warm = now - startedAt < FLOOR_WARMUP_MS;
      floor += (l - floor) * (l < floor ? FLOOR_FALL : warm ? FLOOR_RISE_WARMUP : FLOOR_RISE);
      if (!warm && l >= Math.max(MIN_SPEECH_LEVEL, floor * OVER_NOISE)) {
        aboveSince ??= now;
        lastAbove = now;
        if (now - aboveSince >= ATTACK_MS) talking = true;
      } else if (now - lastAbove > GAP_MS) {
        aboveSince = null;
        if (talking && now - lastAbove >= RELEASE_MS) talking = false;
      }
      const target = talking ? DUCK_VOLUME : 1;
      const next =
        target < gain
          ? Math.max(target, gain - TICK_MS / FADE_DOWN_MS)
          : Math.min(target, gain + TICK_MS / FADE_UP_MS);
      if (next !== gain) {
        gain = next;
        agentTrack.setVolume(gain);
      }
    }, TICK_MS);
    return () => {
      clearInterval(id);
      agentTrack.setVolume(1);
    };
  }, [agentTrack]);
}
