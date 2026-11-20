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

export type Phase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export const ORB = 120;

/** Chiều cao tối đa của mỗi thanh lúc kết nối. */
const BAR_H = 44;

/**
 * Nút micro. Lúc đang nghe, quanh nút có quầng sáng phồng theo âm lượng giọng anh
 * (thay cho quả cầu riêng ở giữa màn hình).
 */
export function MicButton(props: {
  listening: boolean;
  /** Đang kết nối, chưa nghe được: nút mờ đi để anh biết chưa nên nói (vẫn bấm để huỷ được). */
  dimmed?: boolean;
  level: Animated.Value;
  onPress: () => void;
  label: string;
}) {
  const { listening, level } = props;
  const appear = useState(() => new Animated.Value(0))[0];

  useEffect(() => {
    const a = Animated.timing(appear, { toValue: listening ? 1 : 0, duration: 200, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [appear, listening]);

  // Hai lớp quầng: lớp ngoài mờ phồng nhiều, lớp trong đậm phồng ít.
  const ring = (min: number, max: number, opacity: number) => (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.micHalo,
        {
          opacity: Animated.multiply(appear, level.interpolate({ inputRange: [0, 1], outputRange: [opacity * 0.45, opacity], extrapolate: 'clamp' })),
          transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [min, max], extrapolate: 'clamp' }) }],
        },
      ]}
    />
  );

  return (
    <View style={styles.micWrap}>
      {ring(1.1, 2.3, 0.28)}
      {ring(1.04, 1.6, 0.42)}
      <Pressable
        onPress={props.onPress}
        style={[styles.talkBtn, listening && styles.talkBtnActive, props.dimmed && styles.talkBtnDimmed]}
        accessibilityLabel={props.label}
      >
        <MicIcon color={C.ink} size={36} />
      </Pressable>
    </View>
  );
}

/**
 * Ba thanh vàng nhấp nhô lần lượt qua lại (boomerang): đang kết nối, Gừng CHƯA nghe được. Phải khác hẳn
 * quả cầu "đang nghĩ" để anh không tưởng Gừng đã nghe mà nói luôn (mất đoạn đầu).
 */
export function ConnectingBars() {
  const clock = useState(() => new Animated.Value(0))[0];
  const appear = useState(() => new Animated.Value(0))[0];

  useEffect(() => {
    const animations = [
      Animated.timing(appear, { toValue: 1, duration: 250, useNativeDriver: true }),
      // Boomerang: sóng chạy trái → phải rồi quay ngược phải → trái. Đổi chiều cao thật (không
      // dùng scaleY, sẽ bóp dẹt hai đầu bo tròn) nên không chạy được bằng native driver.
      Animated.loop(
        Animated.sequence([
          Animated.timing(clock, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
          Animated.timing(clock, { toValue: 0, duration: 1300, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
        ]),
      ),
    ];
    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, [clock, appear]);

  return (
    <Animated.View style={[styles.bars, { opacity: appear }]}>
      {[0, 1, 2].map((i) => {
        // Đỉnh sóng ở vị trí `clock` (0 = thanh trái, 1 = thanh phải); thanh càng gần đỉnh càng cao,
        // màu giữ nguyên.
        const c = i / 2;
        const near = (low: number) => ({
          inputRange: [c - 0.5, c, c + 0.5],
          outputRange: [low, BAR_H, low],
          extrapolate: 'clamp' as const,
        });
        return (
          <Animated.View
            key={i}
            style={[
              styles.bar,
              { height: clock.interpolate(near(BAR_H * 0.4)) },
            ]}
          />
        );
      })}
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

// Đường nhịp tim (ECG) cho lúc Ginger đang nói. Mỗi khung hình thêm một điểm ở mép trái và
// đẩy cả đường sang phải một bước; độ cao của điểm = âm lượng lúc nó sinh ra. Nhờ vậy nhịp
// chạy từ trái qua phải như máy đo nhịp tim, chỗ to chỗ nhỏ theo giọng đọc.
const WAVE_W = ORB * 2.4;
const WAVE_H = ORB;
const MID = WAVE_H / 2;
const STEP = 2; // px mỗi khung (~60 khung/giây → ~120 px/giây)
const POINTS = Math.ceil(WAVE_W / STEP) + 1;
// Một nhịp (x 0..1, y tính theo đỉnh cao nhất = 1; âm là lên trên).
const BEAT: [number, number][] = [
  [0, 0], [0.28, 0], [0.33, -0.12], [0.38, 0], [0.44, 0], [0.48, 0.25],
  [0.54, -1], [0.6, 0.83], [0.65, 0], [0.72, 0], [0.8, -0.29], [0.88, 0], [1, 0],
];
const BEAT_POINTS = 36; // một nhịp dài 72 px
const BEAT_SHAPE = Array.from({ length: BEAT_POINTS }, (_, j) => {
  const x = j / BEAT_POINTS;
  const k = BEAT.findIndex(([bx]) => bx > x);
  const [x0, y0] = BEAT[k - 1];
  const [x1, y1] = BEAT[k];
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
});
const PEAK = MID * 0.85;

/**
 * Lúc Ginger đang nói: vạch nhịp tim chạy từ trái qua phải, cao thấp theo âm lượng giọng đọc.
 * `level` là ref âm lượng 0..1 (không dùng Animated.Value: giá trị chạy bằng native driver
 * không báo về JS).
 */
export function SpeakingWave({ level }: { level: { current: number } }) {
  const appear = useState(() => new Animated.Value(0))[0];
  const [path, setPath] = useState('');

  useEffect(() => {
    const a = Animated.timing(appear, { toValue: 1, duration: 250, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [appear]);

  useEffect(() => {
    // amps[i] = độ cao của điểm cách mép trái i bước; tick đếm tổng số điểm đã sinh để mỗi
    // điểm giữ đúng vị trí của nó trong nhịp khi trôi sang phải.
    const amps = new Array<number>(POINTS).fill(0);
    let tick = 0;
    let frame = 0;
    const loop = () => {
      tick++;
      amps.pop();
      // Lúc ngắt nghỉ gần như phẳng, nói to thì đỉnh vọt lên.
      amps.unshift(0.08 + 1.07 * Math.min(1, level.current));
      let d = '';
      for (let i = 0; i < POINTS; i++) {
        const y = MID + amps[i] * PEAK * BEAT_SHAPE[(((tick - i) % BEAT_POINTS) + BEAT_POINTS) % BEAT_POINTS];
        d += `${i ? 'L' : 'M'}${(i * STEP).toFixed(0)},${y.toFixed(1)}`;
      }
      setPath(d);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [level]);

  return (
    <Animated.View style={[styles.wave, { opacity: appear }]}>
      <Svg width={WAVE_W} height={WAVE_H}>
        {/* Lớp quầng mờ phía dưới cho cảm giác phát sáng */}
        <Path d={path} stroke={C.primary} strokeOpacity={0.25} strokeWidth={10} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        <Path d={path} stroke={C.primary} strokeWidth={3.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      </Svg>
      {/* Phủ màu nền ở hai mép để vạch sóng mờ dần */}
      <Svg width={WAVE_W} height={WAVE_H} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={C.bg} stopOpacity={1} />
            <Stop offset="0.2" stopColor={C.bg} stopOpacity={0} />
            <Stop offset="0.8" stopColor={C.bg} stopOpacity={0} />
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
  /** Vùng dưới header (thân + nút micro); cây gừng căn giữa vùng này, như vùng dưới header ở chế độ gõ chữ. */
  stage: { flex: 1 },
  // Cây gừng nằm chồng dưới các hiệu ứng khác để mờ dần ra/vào khi đổi trạng thái.
  plantLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  wave: { width: WAVE_W, height: WAVE_H, overflow: 'hidden' },
  orb: { position: 'absolute', width: ORB, height: ORB, borderRadius: ORB / 2, backgroundColor: C.primary },
  // Chung chân: các thanh đứng trên cùng một đáy và chỉ vươn lên, như cột sóng âm thanh.
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, height: BAR_H },
  bar: { width: 10, borderRadius: 5, backgroundColor: C.primary },
  ripple: { backgroundColor: 'transparent', borderWidth: 3, borderColor: C.primary },
  heard: { fontSize: 17, lineHeight: 24, color: C.muted, fontStyle: 'italic', textAlign: 'center' },
  error: { fontSize: 16, color: C.error, textAlign: 'center' },
  footerError: { position: 'absolute', top: -14, left: 24, right: 24, fontSize: 15, lineHeight: 20, color: C.error, textAlign: 'center' },
  // Chừa chỗ cho quầng sáng quanh nút micro (phồng tới ~1,9 lần).
  footer: { alignItems: 'center', paddingBottom: 56, paddingTop: 48 },
  micWrap: { alignItems: 'center', justifyContent: 'center' },
  micHalo: { position: 'absolute', width: 92, height: 92, borderRadius: 46, backgroundColor: C.listening },
  talkBtn: {
    width: 92,
    height: 92,
    borderRadius: 46,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary,
  },
  talkBtnActive: { backgroundColor: C.listening },
  talkBtnDimmed: { opacity: 0.45 },
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
