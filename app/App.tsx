import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlaylist,
  useAudioPlaylistStatus,
  useAudioStream,
} from 'expo-audio';
import { Fredoka_700Bold, useFonts } from '@expo-google-fonts/fredoka';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { VoiceEvent, VoiceSession, voiceAudioSource } from './src/api';

// Bảng màu tông vàng.
const C = {
  bg: '#FFF8E1',
  primary: '#F5B400', // hiệu ứng nghĩ/nói, nút micro
  listening: '#E08600', // lúc đang ghi âm: vàng cam đậm hơn
  ink: '#5C3D00', // chữ đậm, logo
  muted: '#9A8048',
  error: '#B45309',
  line: '#F1E2B3',
};

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

// Bấm ngắn hơn mức này coi như bấm nhầm, bỏ qua.
const MIN_HOLD_MS = 300;

function VoiceScreen() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);

  const conversationId = useRef<string | null>(null);
  const session = useRef<VoiceSession | null>(null);
  const holding = useRef(false);
  const holdStart = useRef(0);
  const streamStarting = useRef<Promise<void> | null>(null);
  // Mỗi lần bấm nút là một lượt mới; sự kiện của lượt cũ (bị ngắt lời) thì bỏ qua.
  const turn = useRef(0);
  // Số câu audio của lượt hiện tại, biết khi server gửi 'reply'.
  const [expectedAudio, setExpectedAudio] = useState<number | null>(null);
  // Số track đã phát xong (lần gần nhất phát hết hàng đợi). Lưu lại vì didJustFinish
  // chỉ đúng trong một lần cập nhật, dễ bị lần cập nhật kế tiếp ghi đè trước khi render.
  const [finishedCount, setFinishedCount] = useState(0);

  // Hàng đợi phát: mỗi câu trả lời là một track, iOS tải trước track kế tiếp.
  // Cập nhật trạng thái mỗi 100 ms để biết chính xác lúc bắt đầu có tiếng.
  const playlist = useAudioPlaylist({ updateInterval: 100 });
  const playlistStatus = useAudioPlaylistStatus(playlist);
  // Âm lượng micro 0..1 để hiệu ứng lúc ghi âm nhún theo giọng anh.
  const micLevel = useRef(new Animated.Value(0)).current;
  // Âm lượng câu trả lời (server gửi theo khung 50 ms) và giá trị đang phát để vạch sóng nhún theo.
  const replyLevels = useRef<number[][]>([]);
  const speakLevel = useRef(new Animated.Value(0)).current;
  const { stream } = useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: 'int16',
    onBuffer: (buf) => {
      session.current?.sendAudio(buf);
      Animated.timing(micLevel, { toValue: levelOf(buf.data), duration: 90, useNativeDriver: true }).start();
    },
  });

  useEffect(() => {
    requestRecordingPermissionsAsync();
  }, []);

  // Hiệu ứng "đang nghĩ" kéo dài tới khi thật sự nghe thấy tiếng. `playing` bật sớm hơn
  // tiếng thật ~2s (iOS còn chuyển audio session), nên đợi vị trí phát chạy qua 0,15s.
  useEffect(() => {
    if (phase === 'thinking' && playlistStatus.playing && playlistStatus.currentTime > 0.15) {
      setPhase('speaking');
    }
  }, [phase, playlistStatus.playing, playlistStatus.currentTime]);

  useEffect(() => {
    const sub = playlist.addListener('playlistStatusUpdate', (st) => {
      if (st.didJustFinish) setFinishedCount(st.trackCount);
      // Trạng thái về mỗi 100 ms: lấy khung lớn hơn trong 2 khung 50 ms tới rồi trượt mượt tới đó.
      let target = 0;
      if (st.playing) {
        const frames = replyLevels.current[st.currentIndex];
        const f = Math.floor(st.currentTime / LEVEL_FRAME_SEC);
        target = Math.max(frames?.[f] ?? 0, frames?.[f + 1] ?? 0);
      }
      Animated.timing(speakLevel, { toValue: target, duration: 110, useNativeDriver: true }).start();
    });
    return () => sub.remove();
  }, [playlist, speakLevel]);

  // Phát hết hàng đợi có thể xảy ra khi câu sau chưa tới, nên chỉ coi là xong khi
  // server đã báo tổng số câu và đã phát hết đủ số câu đó.
  useEffect(() => {
    // Tính cả 'thinking': câu rất ngắn có thể phát xong trước khi kịp chuyển sang 'speaking'.
    if ((phase === 'speaking' || phase === 'thinking') && expectedAudio !== null && finishedCount >= expectedAudio) {
      setPhase('idle');
    }
  }, [phase, expectedAudio, finishedCount]);

  const stopPlayback = useCallback(() => {
    playlist.pause();
    playlist.clear();
    setExpectedAudio(null);
    setFinishedCount(0);
    replyLevels.current = [];
  }, [playlist]);

  const handlerFor = useCallback(
    (myTurn: number) => (e: VoiceEvent) => {
      if (myTurn !== turn.current) return;
      switch (e.type) {
        case 'transcript':
          setHeard(e.text);
          break;
        case 'level': {
          const frames = (replyLevels.current[e.index] ??= []);
          e.values.forEach((v, k) => (frames[e.start + k] = v));
          break;
        }
        case 'audio':
          playlist.add(voiceAudioSource(e.audio_id));
          playlist.volume = 1;
          playlist.play();
          break;
        case 'reply':
          conversationId.current = e.conversation_id;
          session.current = null;
          setExpectedAudio(e.audio_count);
          if (e.audio_count === 0) setPhase('idle');
          break;
        case 'error':
          session.current = null;
          setError(e.message);
          setPhase('idle');
          break;
      }
    },
    [playlist],
  );

  // Bấm lúc đang nghĩ/đang nói thì bỏ lượt cũ (sự kiện của nó bị lọc theo `turn`).
  // Dừng ngay lúc đang nghĩ/đang nói: bỏ lượt hiện tại (sự kiện còn tới sẽ bị lọc theo `turn`).
  const stopReply = useCallback(() => {
    turn.current += 1;
    session.current?.cancel();
    session.current = null;
    stopPlayback();
    setPhase('idle');
  }, [stopPlayback]);

  const startTalking = useCallback(async () => {
    stopPlayback();
    setError(null);

    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError('Anh cần cho phép dùng micro trong Cài đặt.');
      return;
    }

    holding.current = true;
    holdStart.current = Date.now();
    setHeard('');
    setPhase('listening');
    turn.current += 1;
    session.current = new VoiceSession(conversationId.current, handlerFor(turn.current));

    streamStarting.current = (async () => {
      // iOS chỉ cho thu âm khi bật allowsRecording.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await stream.start();
    })();
    try {
      await streamStarting.current;
    } catch (e) {
      holding.current = false;
      session.current?.cancel();
      session.current = null;
      setError(e instanceof Error ? e.message : 'Không mở được micro');
      setPhase('idle');
    }
  }, [stopPlayback, stream, handlerFor]);

  const stopTalking = useCallback(async () => {
    if (!holding.current) return;
    holding.current = false;
    try {
      await streamStarting.current;
    } catch {
      return; // lỗi đã xử lý ở startTalking
    }
    stream.stop();
    // AudioStream đặt session iOS sang category .record + mode .measurement (không phát được).
    // 'doNotMix' khiến expo-audio gọi setCategory(.playback, mode: .default), reset cả mode.
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
    });

    const s = session.current;
    if (!s) return;
    if (Date.now() - holdStart.current < MIN_HOLD_MS) {
      s.cancel();
      session.current = null;
      setPhase('idle');
      return;
    }
    s.end();
    setPhase('thinking');
  }, [stream]);

  const listening = phase === 'listening';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Logo />
      </View>

      {/* Hiệu ứng luôn ở giữa; chữ đặt riêng phía dưới nên hiệu ứng không bị đẩy lệch. */}
      <View style={styles.body}>
        <View style={styles.visual}>
          {phase === 'listening' && <ListeningOrb level={micLevel} />}
          {phase === 'thinking' && <ThinkingOrb />}
          {phase === 'speaking' && <SpeakingWave level={speakLevel} />}
        </View>
        <View style={styles.caption}>
          {heard ? <Text style={styles.heard} numberOfLines={4}>{heard}</Text> : null}
          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      </View>

      <View style={styles.footer}>
        <Pressable
          onPressIn={startTalking}
          onPressOut={stopTalking}
          style={[styles.talkBtn, listening && styles.talkBtnActive]}
        >
          <MicIcon color={C.ink} size={36} />
        </Pressable>
        {/* Luôn giữ chỗ cho nút dừng để nút micro không bị nhảy khi nút dừng hiện/ẩn. */}
        <View style={styles.stopSlot}>
          {(phase === 'thinking' || phase === 'speaking') && (
            <Pressable onPress={stopReply} hitSlop={12} style={styles.stopBtn} accessibilityLabel="Dừng trả lời">
              <View style={styles.stopIcon} />
            </Pressable>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const ORB = 120;
const LEVEL_FRAME_SEC = 0.05;

/** RMS của một gói PCM int16, đổi sang thang 0..1 (căn bậc hai để giọng nhỏ vẫn thấy rõ). */
function levelOf(data: ArrayBuffer): number {
  const samples = new Int16Array(data);
  if (!samples.length) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < samples.length; i += 4) {
    const x = samples[i] / 32768;
    sum += x * x;
    n++;
  }
  return Math.min(1, Math.sqrt(Math.sqrt(sum / n)) * 6.6);
}

/** Lúc đang giữ nút: quả cầu đỏ phồng theo âm lượng giọng nói, kèm quầng sáng. */
function ListeningOrb({ level }: { level: Animated.Value }) {
  const appear = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    level.setValue(0);
    const a = Animated.timing(appear, { toValue: 1, duration: 200, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [appear, level]);

  return (
    <Animated.View style={[styles.visual, { opacity: appear }]}>
      <Animated.View
        style={[
          styles.orb,
          styles.listeningHalo,
          {
            opacity: level.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.35] }),
            transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [1.1, 2] }) }],
          },
        ]}
      />
      <Animated.View
        style={[
          styles.orb,
          styles.listeningOrb,
          { transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.25] }) }] },
        ]}
      />
    </Animated.View>
  );
}

/** Quả cầu "đang nghĩ": hiện từ lúc thả nút tới khi bắt đầu nghe thấy tiếng. */
function ThinkingOrb() {
  // Một đồng hồ chung 0→1; mỗi vòng sóng lệch 1/3 chu kỳ nên sóng toả ra đều nhau.
  const clock = useRef(new Animated.Value(0)).current;
  const breath = useRef(new Animated.Value(0)).current;
  const appear = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animations = [
      Animated.timing(appear, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.loop(Animated.timing(clock, { toValue: 1, duration: 2100, easing: Easing.linear, useNativeDriver: true })),
      Animated.loop(
        Animated.sequence([
          Animated.timing(breath, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(breath, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ),
    ];
    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, [clock, breath, appear]);

  return (
    <Animated.View style={[styles.visual, { opacity: appear, transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }]}>
      {[0, 1, 2].map((i) => {
        const t = Animated.modulo(Animated.add(clock, i / 3), 1);
        return (
          <Animated.View
            key={i}
            style={[
              styles.orb,
              styles.ripple,
              {
                opacity: t.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.45, 0] }),
                transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] }) }],
              },
            ]}
          />
        );
      })}
      <Animated.View
        style={[styles.orb, { transform: [{ scale: breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.1] }) }] }]}
      />
    </Animated.View>
  );
}

// Đường nhịp tim (ECG) cho lúc Ginger đang nói: một chu kỳ dài PERIOD, lặp 3 lần
// rồi trượt sang trái đúng một chu kỳ để vòng lặp liền mạch.
const WAVE_W = ORB * 2.4;
const WAVE_H = ORB;
const PERIOD = WAVE_W / 2;
const MID = WAVE_H / 2;
const BEAT: [number, number][] = [
  [0, 0], [0.28, 0], [0.33, -6], [0.38, 0], [0.44, 0], [0.48, 12],
  [0.54, -48], [0.6, 40], [0.65, 0], [0.72, 0], [0.8, -14], [0.88, 0], [1, 0],
];
const ECG_PATH = [0, 1, 2]
  .flatMap((k) => BEAT.map(([x, y]) => `${((k + x) * PERIOD).toFixed(1)},${(MID + y).toFixed(1)}`))
  .map((p, i) => (i === 0 ? `M${p}` : `L${p}`))
  .join(' ');

/** Lúc Ginger đang nói: vạch sóng nhịp tim chạy ngang, cao thấp theo âm lượng giọng đọc. */
function SpeakingWave({ level }: { level: Animated.Value }) {
  const shift = useRef(new Animated.Value(0)).current;
  const appear = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animations = [
      Animated.timing(appear, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.loop(Animated.timing(shift, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true })),
    ];
    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, [shift, appear]);

  return (
    <Animated.View style={[styles.wave, { opacity: appear }]}>
      <Animated.View
        style={{
          width: PERIOD * 3,
          height: WAVE_H,
          transform: [
            { translateX: shift.interpolate({ inputRange: [0, 1], outputRange: [0, -PERIOD] }) },
            // Lúc ngắt nghỉ gần như phẳng, nói to thì đỉnh vọt lên.
            { scaleY: level.interpolate({ inputRange: [0, 1], outputRange: [0.08, 1.15], extrapolate: 'clamp' }) },
          ],
        }}
      >
        <Svg width={PERIOD * 3} height={WAVE_H}>
          {/* Lớp quầng mờ phía dưới cho cảm giác phát sáng */}
          <Path d={ECG_PATH} stroke={C.primary} strokeOpacity={0.25} strokeWidth={10} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          <Path d={ECG_PATH} stroke={C.primary} strokeWidth={3.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        </Svg>
      </Animated.View>
      {/* Phủ màu nền ở hai mép để vạch sóng mờ dần */}
      <Svg width={WAVE_W} height={WAVE_H} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={C.bg} stopOpacity={1} />
            <Stop offset="0.25" stopColor={C.bg} stopOpacity={0} />
            <Stop offset="0.75" stopColor={C.bg} stopOpacity={0} />
            <Stop offset="1" stopColor={C.bg} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width={WAVE_W} height={WAVE_H} fill="url(#fade)" />
      </Svg>
    </Animated.View>
  );
}

/** Icon micro dạng nét vẽ (outline). */
function MicIcon({ size = 44, color = '#FFF' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={9} y={2.5} width={6} height={12} rx={3} />
      <Path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <Path d="M12 17.5V21" />
      <Path d="M8.5 21h7" />
    </Svg>
  );
}

/** Logo chữ "Ginger" font tròn, "ger" màu vàng. */
function Logo() {
  return (
    <Text style={styles.logoText}>
      Gin<Text style={styles.logoAccent}>ger</Text>
    </Text>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({ Fredoka_700Bold });
  if (!fontsLoaded) return null;
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <VoiceScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
  },
  logoText: { fontFamily: 'Fredoka_700Bold', fontSize: 28, color: C.ink, letterSpacing: 0.5 },
  logoAccent: { color: C.primary },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  caption: { position: 'absolute', left: 24, right: 24, bottom: 16, gap: 8 },
  visual: { width: ORB * 2.4, height: ORB * 2.4, alignItems: 'center', justifyContent: 'center' },
  wave: { width: WAVE_W, height: WAVE_H, overflow: 'hidden' },
  orb: { position: 'absolute', width: ORB, height: ORB, borderRadius: ORB / 2, backgroundColor: C.primary },
  listeningOrb: { backgroundColor: C.listening },
  listeningHalo: { backgroundColor: C.listening },
  ripple: { backgroundColor: 'transparent', borderWidth: 3, borderColor: C.primary },
  heard: { fontSize: 17, lineHeight: 24, color: C.muted, fontStyle: 'italic', textAlign: 'center' },
  error: { fontSize: 16, color: C.error, textAlign: 'center' },
  footer: { alignItems: 'center', gap: 16, paddingBottom: 20, paddingTop: 12 },
  talkBtn: {
    width: 92,
    height: 92,
    borderRadius: 46,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary,
  },
  stopSlot: { height: 44, justifyContent: 'center' },
  stopBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.line,
  },
  stopIcon: { width: 14, height: 14, borderRadius: 3, backgroundColor: C.ink },
  talkBtnActive: { backgroundColor: C.listening, transform: [{ scale: 1.1 }] },
});
