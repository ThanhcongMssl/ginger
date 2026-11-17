/**
 * Chỗ trống bằng phần bàn phím che (trừ vùng an toàn đáy), dâng lên đúng nhịp bàn phím.
 * react-native-keyboard-controller đọc khung bàn phím từng frame trên UI thread (Reanimated),
 * nên khung nhập chữ dính sát mép bàn phím. Trước đây dùng Animated.spring theo sự kiện
 * keyboardWillShow: chạy trên JS nên luôn lên chậm hơn bàn phím vài khung.
 * Android: hook tự đặt chế độ resize nên cửa sổ không tự co, chỗ trống này lo phần đó.
 * Bản web: src/keyboard.web.tsx (trình duyệt tự co viewport).
 */
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { KeyboardProvider, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export { KeyboardProvider };

export function KeyboardSpace() {
  const { bottom } = useSafeAreaInsets();
  const { height } = useReanimatedKeyboardAnimation();
  const style = useAnimatedStyle(() => ({ height: Math.max(-height.value - bottom, 0) }));
  return <Reanimated.View style={style} />;
}
