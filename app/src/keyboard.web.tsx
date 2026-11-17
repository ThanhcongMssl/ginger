/** Bản web: trình duyệt tự co viewport khi bàn phím mở, không cần chỗ trống. Bản native: src/keyboard.tsx. */
import type { ReactNode } from 'react';

export function KeyboardProvider({ children }: { children: ReactNode }) {
  return children;
}

export function KeyboardSpace() {
  return null;
}
