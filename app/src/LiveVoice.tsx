/**
 * Màn hình giọng nói qua LiveKit: dev build (livekit.tsx) hoặc web (livekit.web.tsx).
 * Không chạy trong Expo Go.
 * WebRTC khử tiếng vọng + khử ồn ngay trên máy nên micro mở suốt: anh nói chen vào
 * lúc Ginger đang nói là Ginger dừng lại nghe (agent ở backend/app/agent.py lo phần đó).
 * Chạm mic để bắt đầu trò chuyện, chạm lần nữa để kết thúc.
 * App native tự bắt đầu khi mở app hoặc quay lại app, và kết thúc khi chuyển sang app khác.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { RoomEvent, type LocalAudioTrack, type RemoteAudioTrack } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, Platform, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getLiveKitToken } from './api';
import { SettingsButton } from './Settings';
import {
  PRECONNECT_BUFFER,
  Room,
  startAudio,
  stopAudio,
  useLocalParticipant,
  useRoomContext,
  useAudioLevel,
  useVoiceAssistant,
} from './livekit';
import { useDucking } from './ducking';
import { conversation } from './conversation';
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

// Web (Safari) chỉ cho phát âm thanh sau khi anh chạm vào trang, nên vẫn phải chạm mic.
const AUTO_START = Platform.OS !== 'web';
// Chỉ tự bắt đầu một lần lúc mở app; chuyển từ chế độ gõ chữ về thì không tự bắt đầu.
let launched = false;

export default function LiveVoice({ onTextMode }: { onTextMode: () => void }) {
  const [conn, setConn] = useState<{ url: string; token: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ID cuộc trò chuyện (src/conversation.ts): agent báo qua attribute, lần sau gửi lại để nối tiếp.

  // Mỗi lần bắt đầu/kết thúc tăng số này: kết thúc lúc đang lấy token thì bỏ kết quả cũ.
  const attempt = useRef(0);

  const start = useCallback(async () => {
    const id = ++attempt.current;
    setError(null);
    setStarting(true);
    try {
      await startAudio();
      const c = await getLiveKitToken(conversation.current);
      if (id === attempt.current) setConn(c);
    } catch (e) {
      if (id !== attempt.current) return;
      setError(e instanceof Error ? e.message : 'Không kết nối được');
      setStarting(false);
      stopAudio();
    }
  }, []);

  const end = useCallback(() => {
    attempt.current++;
    setConn(null);
    setStarting(false);
    stopAudio();
  }, []);

  const fail = useCallback(
    (message: string) => {
      setError(message);
      end();
    },
    [end],
  );

  // Đang trò chuyện thì giữ màn hình sáng.
  const active = starting || conn !== null;
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Rảnh tay ngay khi mở app / quay lại app; sang app khác thì kết thúc (STT tính tiền theo
  // phút, và iOS sẽ treo app ở nền). 'inactive' (vd. hộp thoại xin quyền micro) thì bỏ qua.
  useEffect(() => {
    if (!AUTO_START) return;
    if (!launched) {
      launched = true;
      Promise.resolve().then(start);
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') end();
      else if (state === 'active' && !activeRef.current) start();
    });
    return () => sub.remove();
  }, [start, end]);
  useEffect(() => {
    if (!active) return;
    // Trình duyệt có thể từ chối giữ màn hình sáng (vd. pin yếu): bỏ qua.
    activateKeepAwakeAsync('livekit').catch(() => {});
    return () => {
      deactivateKeepAwake('livekit');
    };
  }, [active]);

  if (!conn) {
    return (
      <Layout
        phase={starting ? 'thinking' : 'idle'}
        heard=""
        error={error}
        active={starting}
        onMic={starting ? end : start}
        onHistoryCleared={() => (conversation.current = null)}
        onTextMode={onTextMode}
      />
    );
  }

  return (
    <Room
      serverUrl={conn.url}
      token={conn.token}
      onConnected={() => setStarting(false)}
      onDisconnected={end}
      onError={(e) => {
        setError(e.message);
        end();
      }}
    >
      <Conversation
        onEnd={end}
        onFail={fail}
        onConversationId={(id) => (conversation.current = id)}
      />
    </Room>
  );
}

/** Bên trong phòng: đọc trạng thái agent, âm lượng và chữ anh nói để vẽ giao diện. */
function Conversation({
  onEnd,
  onFail,
  onConversationId,
}: {
  onEnd: () => void;
  onFail: (message: string) => void;
  onConversationId: (id: string) => void;
}) {
  const room = useRoomContext();
  const { state, agent, audioTrack, agentAttributes } = useVoiceAssistant();
  const { microphoneTrack, isMicrophoneEnabled } = useLocalParticipant();
  const agentTrack = audioTrack?.publication?.track as RemoteAudioTrack | undefined;
  const micVolume = useAudioLevel(microphoneTrack?.track as LocalAudioTrack | undefined);
  const agentVolume = useAudioLevel(agentTrack);
  // Anh nói chen vào: giọng Ginger nhỏ dần trước khi server dừng hẳn.
  useDucking(agentTrack, micVolume);
  const [heard, setHeard] = useState('');

  // Agent cần vài giây để vào phòng. Có bộ đệm (web) thì micro đã thu từ lúc này, agent vào
  // sẽ nhận lại phần đã nói, nên hiện "đang nghe" luôn thay vì "đang nghĩ".
  const buffering =
    PRECONNECT_BUFFER && isMicrophoneEnabled && (state === 'connecting' || state === 'initializing');
  const phase: Phase =
    state === 'listening' || buffering ? 'listening' : state === 'speaking' ? 'speaking' : 'thinking';

  // Agent mãi không vào (agent chưa chạy, mạng lỗi) thì báo lỗi thay vì chờ vô hạn.
  useEffect(() => {
    if (agent) return;
    const t = setTimeout(() => onFail('Gừng chưa vào được, thử lại nhé'), 15000);
    return () => clearTimeout(t);
  }, [agent, onFail]);

  useEffect(() => {
    const id = agentAttributes?.conversation_id;
    if (id) onConversationId(id);
  }, [agentAttributes, onConversationId]);

  // Agent rời phòng (anh im lặng lâu, hoặc agent lỗi) thì kết thúc cuộc trò chuyện.
  const hadAgent = useRef(false);
  useEffect(() => {
    if (agent) hadAgent.current = true;
    else if (hadAgent.current) onEnd();
  }, [agent, onEnd]);

  // Chữ anh nói: agent gửi transcript qua text stream 'lk.transcription', đứng tên người gửi là anh.
  useEffect(() => {
    try {
      room.registerTextStreamHandler('lk.transcription', async (reader, from) => {
        if (from.identity !== room.localParticipant.identity) return;
        const text = await reader.readAll();
        if (text.trim()) setHeard(text);
      });
    } catch {
      return; // đã có nơi khác đăng ký topic này: bỏ qua phần hiện chữ
    }
    return () => room.unregisterTextStreamHandler('lk.transcription');
  }, [room]);

  // Ginger bắt đầu nói thì ẩn câu anh vừa nói (trạng thái agent nằm ở attribute 'lk.agent.state').
  useEffect(() => {
    const onAttrs = (changed: Record<string, string>) => {
      if (changed['lk.agent.state'] === 'speaking') setHeard('');
    };
    room.on(RoomEvent.ParticipantAttributesChanged, onAttrs);
    return () => {
      room.off(RoomEvent.ParticipantAttributesChanged, onAttrs);
    };
  }, [room]);

  const micLevel = useLevel(micVolume);
  // Vạch nhịp tim đọc âm lượng mỗi khung hình nên dùng ref (Animated.Value chạy native không đọc được).
  const speakLevel = useRef(0);
  useEffect(() => {
    speakLevel.current = toLevel(agentVolume);
  }, [agentVolume]);

  return (
    <Layout
      phase={phase}
      heard={heard}
      error={null}
      active
      micLevel={micLevel}
      speakLevel={speakLevel}
      onMic={onEnd}
    />
  );
}

/** Âm lượng từ WebRTC (RMS 0..1, thường rất nhỏ) → 0..1; căn bậc hai để giọng nhỏ vẫn thấy nhún. */
const toLevel = (volume: number) => Math.min(1, Math.sqrt(volume) * 1.5);

/** Âm lượng → Animated.Value 0..1 trượt mượt. */
function useLevel(volume: number) {
  const level = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    Animated.timing(level, { toValue: toLevel(volume), duration: 100, useNativeDriver: true }).start();
  }, [volume, level]);
  return level;
}

const NO_LEVEL = { current: 0 };

function Layout(props: {
  phase: Phase;
  heard: string;
  error: string | null;
  active: boolean;
  micLevel?: Animated.Value;
  speakLevel?: { current: number };
  onMic: () => void;
  /** Chỉ có lúc chưa trò chuyện: hiện nút cài đặt và nút chuyển sang gõ chữ. */
  onHistoryCleared?: () => void;
  onTextMode?: () => void;
}) {
  const { phase, heard, error, active, onMic } = props;
  const zero = useState(() => new Animated.Value(0))[0];
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        {props.onTextMode && (
          <HeaderButton side="left" label="Gõ chữ" disabled={active} onPress={props.onTextMode}>
            <KeyboardIcon />
          </HeaderButton>
        )}
        <Logo />
        {props.onHistoryCleared && (
          <SettingsButton disabled={active} onHistoryCleared={props.onHistoryCleared} />
        )}
      </View>

      <View style={styles.body}>
        <View style={styles.visual}>
          {phase === 'thinking' && <ThinkingOrb />}
          {phase === 'speaking' && <SpeakingWave level={props.speakLevel ?? NO_LEVEL} />}
        </View>
        <View style={styles.caption}>
          {heard ? <Text style={styles.heard} numberOfLines={4}>{heard}</Text> : null}
          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      </View>

      <View style={styles.footer}>
        <MicButton
          listening={phase === 'listening'}
          level={props.micLevel ?? zero}
          onPress={onMic}
          label={active ? 'Kết thúc trò chuyện' : 'Bắt đầu trò chuyện'}
        />
      </View>
    </SafeAreaView>
  );
}
