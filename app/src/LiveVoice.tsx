/**
 * Màn hình giọng nói qua LiveKit: dev build (livekit.tsx) hoặc web (livekit.web.tsx).
 * Không chạy trong Expo Go.
 * WebRTC khử tiếng vọng + khử ồn ngay trên máy nên micro mở suốt: anh nói chen vào
 * lúc Ginger đang nói là Ginger dừng lại nghe (agent ở backend/app/agent.py lo phần đó).
 * Chạm mic để bắt đầu trò chuyện, chạm lần nữa hoặc nút dừng để kết thúc.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { RoomEvent, type LocalAudioTrack, type RemoteAudioTrack } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
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
  C,
  HeaderButton,
  KeyboardIcon,
  ListeningOrb,
  Logo,
  MicIcon,
  Phase,
  SpeakingWave,
  ThinkingOrb,
  styles,
} from './ui';

export default function LiveVoice({ onTextMode }: { onTextMode: () => void }) {
  const [conn, setConn] = useState<{ url: string; token: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ID cuộc trò chuyện (src/conversation.ts): agent báo qua attribute, lần sau gửi lại để nối tiếp.

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      await startAudio();
      setConn(await getLiveKitToken(conversation.current));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không kết nối được');
      setStarting(false);
      stopAudio();
    }
  }, []);

  const end = useCallback(() => {
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
        onStop={end}
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
    const t = setTimeout(() => onFail('Ginger chưa vào được, anh thử lại nhé'), 15000);
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
  const speakLevel = useLevel(agentVolume);

  return (
    <Layout
      phase={phase}
      heard={heard}
      error={null}
      active
      micLevel={micLevel}
      speakLevel={speakLevel}
      onMic={onEnd}
      onStop={onEnd}
    />
  );
}

/** Âm lượng từ WebRTC (RMS 0..1, thường rất nhỏ) → Animated.Value 0..1 trượt mượt. */
function useLevel(volume: number) {
  const level = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    // Căn bậc hai để giọng nhỏ vẫn thấy nhún, giống cách tính ở backend.
    const v = Math.min(1, Math.sqrt(volume) * 1.5);
    Animated.timing(level, { toValue: v, duration: 100, useNativeDriver: true }).start();
  }, [volume, level]);
  return level;
}

function Layout(props: {
  phase: Phase;
  heard: string;
  error: string | null;
  active: boolean;
  micLevel?: Animated.Value;
  speakLevel?: Animated.Value;
  onMic: () => void;
  onStop: () => void;
  /** Chỉ có lúc chưa trò chuyện: hiện nút cài đặt và nút chuyển sang gõ chữ. */
  onHistoryCleared?: () => void;
  onTextMode?: () => void;
}) {
  const { phase, heard, error, active, onMic, onStop } = props;
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
          {phase === 'listening' && <ListeningOrb level={props.micLevel ?? zero} />}
          {phase === 'thinking' && <ThinkingOrb />}
          {phase === 'speaking' && <SpeakingWave level={props.speakLevel ?? zero} />}
        </View>
        <View style={styles.caption}>
          {heard ? <Text style={styles.heard} numberOfLines={4}>{heard}</Text> : null}
          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      </View>

      <View style={styles.footer}>
        <Pressable
          onPress={onMic}
          style={[styles.talkBtn, phase === 'listening' && styles.talkBtnActive]}
          accessibilityLabel={active ? 'Kết thúc trò chuyện' : 'Bắt đầu trò chuyện'}
        >
          <MicIcon color={C.ink} size={36} />
        </Pressable>
        {/* Luôn giữ chỗ cho nút dừng để nút micro không bị nhảy khi nút dừng hiện/ẩn. */}
        <View style={styles.stopSlot}>
          {active && (
            <Pressable onPress={onStop} hitSlop={12} style={styles.stopBtn} accessibilityLabel="Kết thúc trò chuyện">
              <View style={styles.stopIcon} />
            </Pressable>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
