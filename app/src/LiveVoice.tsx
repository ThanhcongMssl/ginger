/**
 * Màn hình giọng nói qua LiveKit: dev build (livekit.tsx) hoặc web (livekit.web.tsx).
 * Không chạy trong Expo Go.
 * WebRTC khử tiếng vọng + khử ồn ngay trên máy nên micro mở suốt: anh nói chen vào
 * lúc Ginger đang nói là Ginger dừng lại nghe (agent ở backend/app/agent.py lo phần đó).
 * Chạm mic để bắt đầu trò chuyện, chạm lần nữa để kết thúc. Nút tắt micro bên cạnh (chỉ hiện khi
 * đang trò chuyện) tạm ngừng gửi tiếng lên agent mà không rời phòng; mỗi lần bắt đầu lại thì micro bật.
 * Nút dừng bên trái: Gừng đang nói / đang nghĩ thì tắt tiếng ngay trên máy và nhờ agent ngắt lượt trả lời
 * (RPC 'stop_speaking'), cuộc trò chuyện vẫn tiếp tục.
 * App native tự bắt đầu khi mở app hoặc quay lại app, và kết thúc khi chuyển sang app khác.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { RoomEvent, type LocalAudioTrack, type RemoteAudioTrack } from 'livekit-client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, AppState, Platform, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getLiveKitToken } from './api';
import { MSG_NETWORK, friendlyError } from './errors';
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
import { GingerPlant } from './GingerPlant';
import { conversation } from './conversation';
import {
  ConnectingBars,
  HeaderButton,
  KeyboardIcon,
  Logo,
  MicButton,
  MuteButton,
  Phase,
  StopButton,
  SpeakingWave,
  ThinkingOrb,
  styles,
} from './ui';

// Web (Safari) chỉ cho phát âm thanh sau khi anh chạm vào trang, nên vẫn phải chạm mic.
const AUTO_START = Platform.OS !== 'web';
// Chỉ tự bắt đầu một lần lúc mở app; chuyển từ chế độ gõ chữ về thì không tự bắt đầu.
let launched = false;

export default function LiveVoice({ onTextMode }: { onTextMode: () => void }) {
  // `attempt`: lần bắt đầu nào cấp kết nối này (xem attempt.current bên dưới).
  const [conn, setConn] = useState<{ url: string; token: string; attempt: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Anh tắt micro giữa cuộc trò chuyện: vẫn ở trong phòng, nghe Gừng nói, nhưng không gửi tiếng lên.
  const [muted, setMuted] = useState(false);
  // Nút dừng: phòng LiveKit (Conversation) gắn hàm ngắt lượt trả lời vào đây.
  const stopRef = useRef<(() => void) | null>(null);
  // ID cuộc trò chuyện (src/conversation.ts): agent báo qua attribute, lần sau gửi lại để nối tiếp.

  // Mỗi lần bắt đầu/kết thúc tăng số này: kết thúc lúc đang lấy token thì bỏ kết quả cũ.
  const attempt = useRef(0);

  const start = useCallback(async () => {
    const id = ++attempt.current;
    setError(null);
    setMuted(false);
    setStarting(true);
    try {
      await startAudio();
      const c = await getLiveKitToken(conversation.current);
      if (id === attempt.current) setConn({ ...c, attempt: id });
    } catch (e) {
      if (id !== attempt.current) return;
      setError(friendlyError(e, MSG_NETWORK));
      setStarting(false);
      stopAudio();
    }
  }, []);

  const end = useCallback(() => {
    attempt.current++;
    setConn(null);
    setStarting(false);
    setMuted(false);
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

  // Giao diện luôn là MỘT cây Layout, phòng LiveKit chỉ là con không hiện gì bên trong và báo
  // trạng thái lên. Nếu vẽ Layout riêng trong phòng thì lúc vào phòng React dựng lại từ đầu:
  // icon header nháy, hiệu ứng kết nối chạy lại.
  const [live, setLive] = useState<LiveState>(INITIAL_LIVE);
  const micLevel = useState(() => new Animated.Value(0))[0];
  const speakLevelRef = useRef(0);
  const phase: Phase = conn ? live.phase : starting ? 'connecting' : 'idle';

  // Vừa hết "đang kết nối" (Gừng đã nghe được): rung nhẹ, để biết là nói được mà không cần nhìn.
  const prevPhase = useRef<Phase>('idle');
  useEffect(() => {
    if (prevPhase.current === 'connecting' && phase !== 'connecting' && phase !== 'idle') readyTap();
    prevPhase.current = phase;
  }, [phase]);

  return (
    <Layout
      phase={phase}
      heard={conn ? live.heard : ''}
      error={error}
      active={active}
      canMute={conn !== null}
      muted={muted}
      onMute={() => setMuted((m) => !m)}
      onStop={() => stopRef.current?.()}
      micLevel={micLevel}
      speakLevel={speakLevelRef}
      onMic={active ? end : start}
      onHistoryCleared={() => (conversation.current = null)}
      onTextMode={onTextMode}
    >
      {conn && (
        <Room
          serverUrl={conn.url}
          token={conn.token}
          onConnected={() => setStarting(false)}
          onDisconnected={end}
          onError={(e) => {
            // Anh huỷ lúc đang kết nối: LiveKit báo "Client initiated disconnect", không phải lỗi.
            if (conn.attempt !== attempt.current) return;
            setError(friendlyError(e, MSG_NETWORK));
            end();
          }}
        >
          <Conversation
            onState={setLive}
            muted={muted}
            stopRef={stopRef}
            micLevel={micLevel}
            speakLevelRef={speakLevelRef}
            onEnd={end}
            onFail={fail}
            onConversationId={(id) => (conversation.current = id)}
          />
        </Room>
      )}
    </Layout>
  );
}

type LiveState = { phase: Phase; heard: string };
const INITIAL_LIVE: LiveState = { phase: 'connecting', heard: '' };

/**
 * Bên trong phòng: đọc trạng thái agent, âm lượng và chữ anh nói rồi báo lên LiveVoice vẽ.
 * Không tự vẽ gì.
 */
function Conversation({
  onState,
  muted,
  stopRef,
  micLevel,
  speakLevelRef,
  onEnd,
  onFail,
  onConversationId,
}: {
  onState: (s: LiveState) => void;
  muted: boolean;
  stopRef: { current: (() => void) | null };
  micLevel: Animated.Value;
  speakLevelRef: { current: number };
  onEnd: () => void;
  onFail: (message: string) => void;
  onConversationId: (id: string) => void;
}) {
  const room = useRoomContext();
  const { state, agent, audioTrack, agentAttributes } = useVoiceAssistant();
  const { localParticipant, microphoneTrack, isMicrophoneEnabled } = useLocalParticipant();
  const agentTrack = audioTrack?.publication?.track as RemoteAudioTrack | undefined;
  const micVolume = useAudioLevel(microphoneTrack?.track as LocalAudioTrack | undefined);
  const agentVolume = useAudioLevel(agentTrack);
  // Bấm nút dừng: tắt tiếng Ginger ngay trên máy tới khi agent ngắt xong và quay về nghe.
  const [silenced, setSilenced] = useState(false);
  // Anh nói chen vào: giọng Ginger nhỏ dần trước khi server dừng hẳn.
  useDucking(agentTrack, micVolume, silenced);
  const [heard, setHeard] = useState('');

  // Tắt/bật micro: LiveKit tắt track (không gỡ khỏi phòng) nên agent không nhận được tiếng nào.
  // Lúc mới vào phòng LiveKitRoom tự bật micro: chỉ bật lại khi chính anh vừa bỏ tắt, để khỏi bật
  // chen với nó; anh tắt trước khi micro kịp bật thì micro bật lên xong sẽ bị tắt ngay.
  const unmuting = useRef(false);
  useEffect(() => {
    if (muted) {
      unmuting.current = true;
      if (isMicrophoneEnabled) localParticipant.setMicrophoneEnabled(false).catch(() => {});
    } else if (unmuting.current) {
      unmuting.current = false;
      if (!isMicrophoneEnabled) localParticipant.setMicrophoneEnabled(true).catch(() => {});
    }
  }, [muted, isMicrophoneEnabled, localParticipant]);

  // Agent cần vài giây để vào phòng. Có bộ đệm (web) thì micro đã thu từ lúc này, agent vào
  // sẽ nhận lại phần đã nói, nên hiện "đang nghe" luôn thay vì "đang kết nối".
  const buffering =
    PRECONNECT_BUFFER && isMicrophoneEnabled && (state === 'connecting' || state === 'initializing');
  // Agent báo 'listening' ngay khi vào phòng nhưng còn 1–3s nữa mới nhận được audio của micro;
  // nói lúc đó là mất. Agent đặt attribute 'mic_ready' khi audio thật đầu tiên tới (agent.py).
  // Web có bộ đệm trước khi vào phòng nên không mất chữ, không cần chờ.
  const micReady = PRECONNECT_BUFFER || agentAttributes?.mic_ready === '1';
  // 'idle' giữa phiên: micro vẫn mở, coi như đang nghe.
  const phase: Phase =
    ((state === 'listening' || state === 'idle') && micReady) || buffering
      ? 'listening'
      : state === 'speaking' || state === 'thinking'
        ? state
        : 'connecting';

  // Nút dừng: tắt tiếng trên máy ngay và nhờ agent ngắt lượt trả lời (agent.py, 'stop_speaking').
  useEffect(() => {
    stopRef.current = () => {
      if (!agent || (state !== 'speaking' && state !== 'thinking')) return;
      setSilenced(true);
      room.localParticipant
        .performRpc({ destinationIdentity: agent.identity, method: 'stop_speaking', payload: '' })
        .catch(() => {}); // agent cũ chưa có RPC này: vẫn tắt tiếng trên máy tới hết câu
    };
    return () => {
      stopRef.current = null;
    };
  }, [stopRef, agent, state, room]);
  // Agent đã thôi nói (quay về nghe) thì bật lại tiếng cho câu sau (chỉnh state ngay lúc render).
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    if (silenced && (state === 'listening' || state === 'idle')) setSilenced(false);
  }

  useEffect(() => {
    onState({ phase, heard });
  }, [phase, heard, onState]);
  // Rời phòng thì trả về trạng thái đầu cho lần sau.
  useEffect(() => () => onState(INITIAL_LIVE), [onState]);

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

  // Âm lượng micro → quầng sáng quanh nút (trượt mượt). Vạch nhịp tim đọc âm lượng Ginger mỗi
  // khung hình nên dùng ref (Animated.Value chạy native không đọc được).
  useEffect(() => {
    Animated.timing(micLevel, { toValue: micToLevel(micVolume), duration: 80, useNativeDriver: true }).start();
  }, [micVolume, micLevel]);
  useEffect(() => {
    speakLevelRef.current = toLevel(agentVolume);
  }, [agentVolume, speakLevelRef]);
  useEffect(
    () => () => {
      micLevel.setValue(0);
      speakLevelRef.current = 0;
    },
    [micLevel, speakLevelRef],
  );

  return null;
}

// Nạp khi cần: dev build cũ chưa có module native này.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const haptics = (): typeof import('expo-haptics') => require('expo-haptics');

function readyTap() {
  if (Platform.OS === 'web') return;
  try {
    haptics().impactAsync(haptics().ImpactFeedbackStyle.Medium).catch(() => {});
  } catch {
    // dev build cũ chưa có expo-haptics: bỏ qua
  }
}

/** Âm lượng từ WebRTC (RMS 0..1, thường rất nhỏ) → 0..1; căn bậc hai để giọng nhỏ vẫn thấy nhún. */
const toLevel = (volume: number) => Math.min(1, Math.sqrt(volume) * 1.5);

/**
 * Âm lượng micro → 0..1 cho quầng sáng. Micro đã qua khử vọng/AGC nên nhỏ hơn giọng Ginger:
 * nói thường chỉ ra ~0,3 theo toLevel, quầng gần như đứng yên. Ở đây trừ ồn nền (căn bậc hai
 * ~0,04) rồi khuếch đại mạnh, nói thường đã lên ~0,6–0,9.
 */
const micToLevel = (volume: number) => Math.min(1, Math.max(0, Math.sqrt(volume) - 0.04) * 3.5);

function Layout(props: {
  phase: Phase;
  heard: string;
  error: string | null;
  active: boolean;
  /** Đã vào phòng: hiện nút tắt micro. */
  canMute: boolean;
  muted: boolean;
  onMute: () => void;
  onStop: () => void;
  micLevel: Animated.Value;
  speakLevel: { current: number };
  onMic: () => void;
  onHistoryCleared: () => void;
  onTextMode: () => void;
  /** Phòng LiveKit (không hiện gì, chỉ báo trạng thái lên). */
  children?: ReactNode;
}) {
  const { phase, heard, error, active, muted } = props;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* Đang trò chuyện thì khoá (mờ) hai nút header, không ẩn đi để khỏi nháy. */}
      <View style={styles.header}>
        <HeaderButton side="left" label="Gõ chữ" disabled={active} onPress={props.onTextMode}>
          <KeyboardIcon />
        </HeaderButton>
        <Logo />
        <SettingsButton disabled={active} onHistoryCleared={props.onHistoryCleared} />
      </View>

      <View style={styles.stage}>
        {/* Cây gừng căn giữa cả vùng dưới header, giống hệt chỗ của nó ở chế độ gõ chữ. */}
        <View style={styles.plantLayer} pointerEvents="none">
          <GingerPlant visible={phase === 'idle'} />
        </View>
        <View style={styles.body}>
          <View style={styles.visual}>
            {phase === 'connecting' && <ConnectingBars />}
            {phase === 'thinking' && <ThinkingOrb />}
            {phase === 'speaking' && <SpeakingWave level={props.speakLevel} />}
          </View>
          <View style={styles.caption}>
            {props.canMute && muted ? (
              <Text style={styles.heard}>Micro đang tắt, Gừng không nghe thấy anh</Text>
            ) : heard ? (
              <Text style={styles.heard} numberOfLines={4}>{heard}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.footer}>
          {/* Lỗi nằm trên phần đất, ngay trên nút micro: không đè lên cây gừng. */}
          {error && (
            <Text style={styles.footerError} numberOfLines={1}>
              {error}
            </Text>
          )}
          {/* Nút micro luôn ở giữa; nút tắt micro bên trái, nút dừng bên phải (chỉ hiện khi đã vào phòng), chỉ có icon. */}
          <View style={styles.footerRow}>
            <View style={styles.sideSlot}>
              {props.canMute && <MuteButton muted={muted} onPress={props.onMute} />}
            </View>
            <MicButton
              listening={phase === 'listening' && !(props.canMute && muted)}
              dimmed={phase === 'connecting'}
              level={props.micLevel}
              onPress={props.onMic}
              label={active ? 'Kết thúc trò chuyện' : 'Bắt đầu trò chuyện'}
            />
            <View style={styles.sideSlot}>
              {props.canMute && (
                <StopButton
                  enabled={phase === 'speaking' || phase === 'thinking'}
                  onPress={props.onStop}
                />
              )}
            </View>
          </View>
        </View>
      </View>
      {props.children}
    </SafeAreaView>
  );
}
