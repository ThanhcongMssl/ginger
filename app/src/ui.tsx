/** Phần giao diện dùng chung cho cả hai màn hình giọng nói. */
import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

// Bảng màu tông vàng.
export const C = {
  bg: '#FFF8E1',
  primary: '#F5B400', // hiệu ứng nghĩ/nói, nút micro
  listening: '#E08600', // lúc đang ghi âm: vàng cam đậm hơn
  ink: '#5C3D00', // chữ đậm, logo
  muted: '#9A8048',
  error: '#B45309',
  line: '#F1E2B3',
};

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

export const ORB = 120;

/** Lúc đang giữ nút: quả cầu đỏ phồng theo âm lượng giọng nói, kèm quầng sáng. */
export function ListeningOrb({ level }: { level: Animated.Value }) {
  const appear = useState(() => new Animated.Value(0))[0];

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
export function ThinkingOrb() {
  // Một đồng hồ chung 0→1; mỗi vòng sóng lệch 1/3 chu kỳ nên sóng toả ra đều nhau.
  const clock = useState(() => new Animated.Value(0))[0];
  const breath = useState(() => new Animated.Value(0))[0];
  const appear = useState(() => new Animated.Value(0))[0];

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
export function SpeakingWave({ level }: { level: Animated.Value }) {
  const shift = useState(() => new Animated.Value(0))[0];
  const appear = useState(() => new Animated.Value(0))[0];

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

/** Icon bánh răng (cài đặt), nét vẽ theo bộ Lucide. */
export function GearIcon({ size = 24, color = C.ink }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <Circle cx={12} cy={12} r={3} />
    </Svg>
  );
}

/** Icon bàn phím (chuyển sang gõ chữ), nét vẽ theo bộ Lucide. */
export function KeyboardIcon({ size = 24, color = C.ink }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={2} y={4} width={20} height={16} rx={2} />
      <Path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
    </Svg>
  );
}

/** Icon quay lại (mũi tên trái), nét vẽ theo bộ Lucide. */
export function BackIcon({ size = 26, color = C.listening }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M15 18l-6-6 6-6" />
    </Svg>
  );
}

/** Icon mũi tên gửi tin nhắn. */
export function SendIcon({ size = 22, color = C.ink }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 19V5M5 12l7-7 7 7" />
    </Svg>
  );
}

/** Nút icon ở góc trái/phải header. */
export function HeaderButton(props: {
  side: 'left' | 'right';
  label: string;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <View style={props.side === 'left' ? styles.headerActionLeft : styles.headerAction}>
      <Pressable
        onPress={props.onPress}
        disabled={props.disabled}
        hitSlop={8}
        style={[styles.headerBtn, props.disabled && { opacity: 0.35 }]}
        accessibilityLabel={props.label}
      >
        {props.children}
      </Pressable>
    </View>
  );
}

/** Icon micro dạng nét vẽ (outline). */
export function MicIcon({ size = 44, color = '#FFF' }: { size?: number; color?: string }) {
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
export function Logo() {
  return (
    <Text style={styles.logoText}>
      Gin<Text style={styles.logoAccent}>ger</Text>
    </Text>
  );
}

export const styles = StyleSheet.create({
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
  unlockBtn: {
    position: 'absolute',
    top: 72,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: C.ink,
  },
  unlockText: { color: C.bg, fontSize: 16, fontWeight: '600' },
  headerAction: { position: 'absolute', right: 8, top: 0, bottom: 0, justifyContent: 'center' },
  headerActionLeft: { position: 'absolute', left: 8, top: 0, bottom: 0, justifyContent: 'center' },
  headerBtn: { padding: 8 },
  gate: { flex: 1, justifyContent: 'center', paddingHorizontal: 32, gap: 16 },
  gateLabel: { fontSize: 17, color: C.ink, textAlign: 'center' },
  gateInput: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: C.ink,
    backgroundColor: '#FFFFFF',
  },
  gateBtn: { alignItems: 'center', paddingVertical: 14, borderRadius: 12, backgroundColor: C.primary },
  gateBtnText: { fontSize: 17, fontWeight: '600', color: C.ink },
});
