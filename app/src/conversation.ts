/**
 * Cuộc trò chuyện đang mở, dùng chung cho chế độ nói và chế độ gõ chữ: chuyển qua lại
 * giữa hai chế độ vẫn nối tiếp cùng một cuộc. null = lượt tới bắt đầu cuộc mới.
 * Có dạng ref (`.current`) để các màn hình dùng như useRef.
 */
export const conversation: { current: string | null } = { current: null };
