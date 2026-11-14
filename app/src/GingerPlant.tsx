/**
 * Cây gừng vẽ bằng SVG cho khoảng trống: màn hình nói lúc chưa vào phòng và khung chat trống.
 * Củ gừng chôn dưới mặt đất (vạch mảnh kéo hết bề ngang màn hình), chỉ ló vài mấu; ba nhánh lá
 * đung đưa quanh gốc, mỗi nhánh một nhịp. Từ mặt đất trở xuống tới đáy màn hình là "lòng đất"
 * màu nền đậm hơn. Cây và lòng đất cùng hiện/ẩn dần khi đổi trạng thái (`visible`).
 */
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { G, Path, Rect } from 'react-native-svg';

const W = 180;
/** Khung cây kết thúc ở mặt đất. */
const H = 215;
/** Chỗ thân lá cắm vào củ (toạ độ y trong khung). */
const BASE_Y = 210;
/** Chừa phía trên thân cho lá ngọn chĩa lên. */
const PAD = 44;

const LEAF = '#7FA33A';
const LEAF_DARK = '#5E7F26';
const VEIN = '#A9C766';
const STEM = '#6E8F2C';
const ROOT = '#EBC07A';
const ROOT_LINE = '#B07A2E';
const SOIL = '#A87A4A';
/** Lòng đất: đậm hơn nền app (C.bg #FFF8E1) một chút. */
const UNDERGROUND = '#F7E8C2';
const FADE_MS = 400;

/** Lá: [vị trí dọc thân 0..1 tính từ gốc, bên (-1 trái, 1 phải, 0 ngọn), góc so với thân, dài, rộng]. */
type Leaf = [number, -1 | 0 | 1, number, number, number];
type Shoot = { x: number; h: number; lean: number; amp: number; ms: number; delay: number; leaves: Leaf[] };

const SHOOTS: Shoot[] = [
  {
    x: 71, h: 128, lean: -14, amp: 4, ms: 2600, delay: 0,
    leaves: [[0.35, -1, 58, 44, 8], [0.55, 1, 52, 48, 9], [0.75, -1, 48, 46, 8.5], [1, 0, 0, 34, 7]],
  },
  {
    x: 113, h: 142, lean: 12, amp: 3.5, ms: 3100, delay: 700,
    leaves: [[0.32, 1, 56, 46, 8.5], [0.52, -1, 50, 50, 9], [0.74, 1, 46, 46, 8.5], [1, 0, 0, 36, 7]],
  },
  {
    x: 90, h: 172, lean: 0, amp: 3, ms: 3500, delay: 300,
    leaves: [[0.3, -1, 55, 50, 9], [0.48, 1, 52, 56, 10], [0.66, -1, 48, 54, 9.5], [0.84, 1, 42, 46, 8.5], [1, 0, 0, 40, 7.5]],
  },
];

const leafPath = (l: number, w: number) =>
  `M0 0 C${l * 0.3} ${-w} ${l * 0.72} ${-w * 0.75} ${l} 0 C${l * 0.72} ${w * 0.55} ${l * 0.3} ${w * 0.85} 0 0Z`;

const ROOT_PATH =
  'M20 40 C10 40 8 28 18 24 C24 14 36 16 42 22 C48 12 62 10 70 18 C78 8 96 8 100 20 ' +
  'C110 14 128 16 130 28 C142 30 144 44 132 48 C120 56 100 52 90 50 C76 56 56 56 46 50 C34 54 22 52 20 40Z';
const ROOT_RINGS = 'M44 25 Q49 36 45 47 M72 21 Q78 35 73 50 M103 22 Q108 34 104 46 M124 30 Q127 38 124 45';
/** Củ thu nhỏ còn 75% (khung gốc 150×60). */
const ROOT_SCALE = 0.75;

/** Mặt đất: một vạch mảnh ở y=212, kéo hết bề ngang màn hình. */
const SOIL_Y = 212;
const SOIL_H = 3;

/**
 * Vạch đất và lòng đất rộng bằng màn hình (cây luôn ở giữa màn hình nên khung cây nằm giữa).
 * Lòng đất cao bằng cả màn hình, tràn xuống dưới khung cây tới đáy màn hình; phần thừa bị màn hình cắt.
 */
function Ground() {
  const { width, height } = useWindowDimensions();
  const left = (W - width) / 2;
  return (
    <>
      <View style={[s.underground, { left, width, height }]} pointerEvents="none" />
      <Svg width={width} height={SOIL_H} style={[s.ground, { left }]} pointerEvents="none">
        <Rect x={0} y={0} width={width} height={SOIL_H} rx={SOIL_H / 2} fill={SOIL} />
      </Svg>
    </>
  );
}

function SwayingShoot({ shoot }: { shoot: Shoot }) {
  const { x, h, lean, amp, ms, delay, leaves } = shoot;
  const sway = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    const half = (to: number) =>
      Animated.timing(sway, { toValue: to, duration: ms / 2, easing: Easing.inOut(Easing.sin), useNativeDriver: true });
    const a = Animated.sequence([Animated.delay(delay), Animated.loop(Animated.sequence([half(1), half(0)]))]);
    a.start();
    return () => a.stop();
  }, [sway, ms, delay]);

  const top = PAD;
  const height = h + PAD;
  return (
    <Animated.View
      style={[
        s.shoot,
        {
          left: x - 50,
          top: BASE_Y - height,
          height,
          transform: [{ rotate: sway.interpolate({ inputRange: [0, 1], outputRange: [`${lean - amp}deg`, `${lean + amp}deg`] }) }],
        },
      ]}
    >
      <Svg width={100} height={height}>
        <Path d={`M50 ${height} L50 ${top + 6}`} stroke={STEM} strokeWidth={3} strokeLinecap="round" />
        {leaves.map(([t, side, angle, l, w], i) => (
          <G key={i} transform={`translate(50 ${height - t * (h - 6)}) rotate(${-90 + side * angle})`}>
            <Path d={leafPath(l, w)} fill={side < 0 ? LEAF_DARK : LEAF} />
            <Path d={`M2 0 Q${l * 0.5} ${-w * 0.12} ${l * 0.92} 0`} stroke={VEIN} strokeWidth={1} fill="none" strokeLinecap="round" />
          </G>
        ))}
      </Svg>
    </Animated.View>
  );
}

/** `visible` false: mờ dần rồi gỡ hẳn (dừng các vòng lặp đung đưa); true: hiện dần. */
export function GingerPlant({ visible = true }: { visible?: boolean }) {
  const appear = useState(() => new Animated.Value(0))[0];
  const [gone, setGone] = useState(!visible);
  if (visible && gone) setGone(false);
  useEffect(() => {
    const a = Animated.timing(appear, {
      toValue: visible ? 1 : 0,
      duration: FADE_MS,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: true,
    });
    a.start(({ finished }) => {
      if (finished && !visible) setGone(true);
    });
    return () => a.stop();
  }, [appear, visible]);

  if (!visible && gone) return null;
  return (
    <Animated.View style={[s.wrap, { opacity: appear }]} accessible={false} importantForAccessibility="no-hide-descendants">
      <Ground />
      {SHOOTS.map((sh) => (
        <SwayingShoot key={sh.x} shoot={sh} />
      ))}
      {/* Củ che gốc thân lá. Khung SVG dừng ở mặt đất nên phần củ dưới đất bị cắt, chỉ ló vài mấu. */}
      <Svg width={W} height={SOIL_Y} style={s.root} pointerEvents="none">
        <G transform={`translate(33 196) scale(${ROOT_SCALE})`}>
          <Path d={ROOT_PATH} fill={ROOT} stroke={ROOT_LINE} strokeWidth={2} strokeLinejoin="round" />
          <Path d={ROOT_RINGS} stroke={ROOT_LINE} strokeWidth={1.5} fill="none" strokeLinecap="round" opacity={0.6} />
        </G>
      </Svg>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: { width: W, height: H },
  // Xoay quanh gốc thân (giữa cạnh dưới).
  shoot: { position: 'absolute', width: 100, transformOrigin: 'bottom' },
  root: { position: 'absolute', left: 0, top: 0 },
  ground: { position: 'absolute', top: SOIL_Y },
  underground: { position: 'absolute', top: SOIL_Y, backgroundColor: UNDERGROUND },
});
