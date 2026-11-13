/**
 * Màn hình giọng nói cho Expo Go (không có khử tiếng vọng): chạm mic = rảnh tay kiểu
 * half-duplex (micro tắt khi Ginger nói). Đang nghe mà chạm mic thì kết thúc, lúc Ginger
 * đang nghĩ/nói thì ngắt lời. Âm thanh đi qua WebSocket /voice của backend.
 * Bản dev build dùng LiveVoice (LiveKit) thay thế.
 */
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlaylist,
  useAudioStream,
} from 'expo-audio';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { VoiceEvent, VoiceSession, voiceAudioSource } from './api';
import { conversation } from './conversation';
import { SettingsButton } from './Settings';
import {
  HeaderButton,
  KeyboardIcon,
  Logo,
  MicButton,
  Phase,
  SpeakingWave,
  ThinkingOrb,
  styles,
} from './ui';

const LEVEL_FRAME_SEC = 0.05;

// Rảnh tay: im lặng lâu như vậy thì tự thoát (Soniox STT tính tiền theo phút audio).
const SILENCE_EXIT_MS = 20000;

export default function ExpoGoVoice({ onTextMode }: { onTextMode: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Rảnh tay: nghe → trả lời → tự nghe tiếp, chốt lượt khi anh ngừng nói.
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  const phaseRef = useRef<Phase>('idle');
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const session = useRef<VoiceSession | null>(null);
  const permitted = useRef(false);
  // Chỉ gửi audio lên server khi đang nghe.
  const micOn = useRef(false);
  const micStarted = useRef(false);
  const micQueue = useRef<Promise<unknown>>(Promise.resolve());
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mỗi lượt có một số; sự kiện của lượt cũ (bị ngắt lời) thì bỏ qua.
  const turn = useRef(0);
  // Số câu audio của lượt hiện tại, biết khi server gửi 'reply'.
  const [expectedAudio, setExpectedAudio] = useState<number | null>(null);
  // Số track đã phát xong (lần gần nhất phát hết hàng đợi). Lưu lại vì didJustFinish
  // chỉ đúng trong một lần cập nhật, dễ bị lần cập nhật kế tiếp ghi đè trước khi render.
  const [finishedCount, setFinishedCount] = useState(0);

  // Hàng đợi phát: mỗi câu trả lời là một track, iOS tải trước track kế tiếp.
  // Cập nhật trạng thái mỗi 100 ms để biết chính xác lúc bắt đầu có tiếng.
  const playlist = useAudioPlaylist({ updateInterval: 100 });
  // Âm lượng micro 0..1 để hiệu ứng lúc ghi âm nhún theo giọng anh.
  const micLevel = useState(() => new Animated.Value(0))[0];
  // Âm lượng câu trả lời (server gửi theo khung 50 ms) và giá trị đang phát để vạch sóng nhún theo.
  const replyLevels = useRef<number[][]>([]);
  // Ref (không phải Animated.Value) vì vạch nhịp tim đọc nó mỗi khung hình.
  const speakLevel = useRef(0);
  const { stream } = useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: 'int16',
    onBuffer: (buf) => {
      if (!micOn.current) return;
      session.current?.sendAudio(buf);
      Animated.timing(micLevel, { toValue: levelOf(buf.data), duration: 90, useNativeDriver: true }).start();
    },
  });

  useEffect(() => {
    requestRecordingPermissionsAsync().then((p) => (permitted.current = p.granted));
  }, []);

  // Rảnh tay thì giữ màn hình sáng để không bị khoá giữa cuộc trò chuyện.
  useEffect(() => {
    if (!handsFree) return;
    activateKeepAwakeAsync('handsfree');
    return () => {
      deactivateKeepAwake('handsfree');
    };
  }, [handsFree]);

  useEffect(() => {
    const sub = playlist.addListener('playlistStatusUpdate', (st) => {
      if (st.didJustFinish) setFinishedCount(st.trackCount);
      // Hiệu ứng "đang nghĩ" kéo dài tới khi thật sự nghe thấy tiếng. `playing` bật sớm hơn
      // tiếng thật ~2s (iOS còn chuyển audio session), nên đợi vị trí phát chạy qua 0,15s.
      if (st.playing && st.currentTime > 0.15 && phaseRef.current === 'thinking') {
        phaseRef.current = 'speaking';
        setPhase('speaking');
        setHeard('');
      }
      // Trạng thái về mỗi 100 ms: lấy khung lớn hơn trong 2 khung 50 ms tới rồi trượt mượt tới đó.
      let target = 0;
      if (st.playing) {
        const frames = replyLevels.current[st.currentIndex];
        const f = Math.floor(st.currentTime / LEVEL_FRAME_SEC);
        target = Math.max(frames?.[f] ?? 0, frames?.[f + 1] ?? 0);
      }
      speakLevel.current = target;
    });
    return () => sub.remove();
  }, [playlist]);

  const stopPlayback = useCallback(() => {
    playlist.pause();
    playlist.clear();
    setExpectedAudio(null);
    setFinishedCount(0);
    replyLevels.current = [];
  }, [playlist]);

  /** Bật/tắt micro chạy tuần tự, để lần tắt chưa xong không đè lên lần bật ngay sau đó. */
  const runMic = useCallback((op: () => Promise<void>) => {
    const p = micQueue.current.then(op);
    micQueue.current = p.catch(() => {});
    return p;
  }, []);

  const openMic = useCallback(() => {
    micOn.current = true;
    return runMic(async () => {
      if (!micOn.current || micStarted.current) return;
      // iOS chỉ cho thu âm khi bật allowsRecording.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await stream.start();
      micStarted.current = true;
    });
  }, [runMic, stream]);

  const closeMic = useCallback(() => {
    micOn.current = false;
    return runMic(async () => {
      if (!micStarted.current) return;
      micStarted.current = false;
      stream.stop();
      // AudioStream đặt session iOS sang category .record + mode .measurement (không phát được).
      // 'doNotMix' khiến expo-audio gọi setCategory(.playback, mode: .default), reset cả mode.
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
      });
    });
  }, [runMic, stream]);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    silenceTimer.current = null;
  }, []);

  /** Dừng hết: thoát rảnh tay, bỏ lượt hiện tại, tắt micro và tiếng. */
  const stopAll = useCallback(() => {
    turn.current += 1;
    handsFreeRef.current = false;
    setHandsFree(false);
    clearSilenceTimer();
    session.current?.cancel();
    session.current = null;
    closeMic();
    stopPlayback();
    setPhase('idle');
  }, [clearSilenceTimer, closeMic, stopPlayback]);

  const armSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    silenceTimer.current = setTimeout(() => {
      if (handsFreeRef.current && phaseRef.current === 'listening') stopAll();
    }, SILENCE_EXIT_MS);
  }, [clearSilenceTimer, stopAll]);

  /** Bắt đầu một lượt nghe trên `session` hiện tại. */
  const listen = useCallback(() => {
    turn.current += 1;
    session.current?.startTurn(turn.current);
    setHeard('');
    setError(null);
    setPhase('listening');
    if (handsFreeRef.current) armSilenceTimer();
    openMic().catch((e: unknown) => {
      stopAll();
      setError(e instanceof Error ? e.message : 'Không mở được micro');
    });
  }, [armSilenceTimer, openMic, stopAll]);

  // Phát hết hàng đợi có thể xảy ra khi câu sau chưa tới, nên chỉ coi là xong khi
  // server đã báo tổng số câu và đã phát hết đủ số câu đó.
  useEffect(() => {
    // Tính cả 'thinking': câu rất ngắn có thể phát xong trước khi kịp chuyển sang 'speaking'.
    if ((phase === 'speaking' || phase === 'thinking') && expectedAudio !== null && finishedCount >= expectedAudio) {
      // Phát xong câu trả lời: nghe tiếp lượt sau (chạy sau render, không setState ngay trong effect).
      Promise.resolve().then(() => {
        stopPlayback();
        listen();
      });
    }
  }, [phase, expectedAudio, finishedCount, stopPlayback, listen]);

  const handleEvent = useCallback(
    (e: VoiceEvent) => {
      if (e.turn !== turn.current) return;
      switch (e.type) {
        case 'partial':
          setHeard(e.text);
          if (handsFreeRef.current) armSilenceTimer();
          break;
        case 'transcript':
          setHeard(e.text);
          // Rảnh tay: server đã chốt lượt vì anh ngừng nói. Tắt micro để không thu tiếng Ginger.
          if (handsFreeRef.current) {
            clearSilenceTimer();
            closeMic();
            setPhase('thinking');
          }
          break;
        case 'level': {
          const frames = (replyLevels.current[e.index] ??= []);
          e.values.forEach((v, k) => (frames[e.start + k] = v));
          break;
        }
        case 'audio':
          playlist.add(voiceAudioSource(e.audio_id));
          playlist.play();
          break;
        case 'reply':
          conversation.current = e.conversation_id;
          setExpectedAudio(e.audio_count);
          break;
        case 'error':
          stopAll();
          setError(e.message);
          break;
      }
    },
    [playlist, armSilenceTimer, clearSilenceTimer, closeMic, stopAll],
  );

  /** Chạm mic: chưa trò chuyện thì bắt đầu rảnh tay; đang nghe thì thoát; Ginger đang nghĩ/nói thì ngắt lời. */
  const onMic = useCallback(async () => {
    if (handsFreeRef.current) {
      if (phaseRef.current === 'listening') {
        stopAll();
      } else {
        stopPlayback();
        listen();
      }
      return;
    }
    if (!permitted.current) {
      const perm = await requestRecordingPermissionsAsync();
      permitted.current = perm.granted;
      if (!perm.granted) {
        setError('Cần cho phép dùng micro trong Cài đặt.');
        return;
      }
    }
    stopPlayback();
    handsFreeRef.current = true;
    setHandsFree(true);
    session.current = new VoiceSession(conversation.current, handleEvent);
    session.current.setHandsFree();
    listen();
  }, [stopAll, stopPlayback, listen, handleEvent]);

  const listening = phase === 'listening';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <HeaderButton side="left" label="Gõ chữ" disabled={phase !== 'idle' || handsFree} onPress={onTextMode}>
          <KeyboardIcon />
        </HeaderButton>
        <Logo />
        <SettingsButton
          disabled={phase !== 'idle' || handsFree}
          onHistoryCleared={() => (conversation.current = null)}
        />
      </View>

      {/* Hiệu ứng luôn ở giữa; chữ đặt riêng phía dưới nên hiệu ứng không bị đẩy lệch. */}
      <View style={styles.body}>
        <View style={styles.visual}>
          {phase === 'thinking' && <ThinkingOrb />}
          {phase === 'speaking' && <SpeakingWave level={speakLevel} />}
        </View>
        <View style={styles.caption}>
          {heard ? <Text style={styles.heard} numberOfLines={4}>{heard}</Text> : null}
          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      </View>

      <View style={styles.footer}>
        <MicButton
          listening={listening}
          level={micLevel}
          onPress={onMic}
          label={handsFree ? (listening ? 'Kết thúc trò chuyện' : 'Ngắt lời') : 'Bắt đầu trò chuyện'}
        />
      </View>
    </SafeAreaView>
  );
}

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
