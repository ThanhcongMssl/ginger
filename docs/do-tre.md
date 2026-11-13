# Độ trễ mỗi lượt nói

Tính từ lúc anh nói xong tới lúc nghe thấy tiếng Ginger. Đo ngày 13/11/2026 bằng client
Python giả làm app (`room.connect` + phát file wav câu hỏi), 5 lượt mỗi lần đo, agent chạy
trong WSL, LiveKit Cloud region India South.

## Hiện tại: trung vị ~3,0s

| Chặng | Thời gian | Ghi chú |
|---|---|---|
| Soniox chốt lượt (anh ngừng nói → có transcript cuối) | ~0,85s | `max_endpoint_delay_ms=500` đã là mức thấp nhất |
| Tìm ký ức | ~0,01s | ≤ 40 ký ức thì đưa hết vào prompt, không gọi Voyage |
| Claude ra chữ đầu | ~0,75s | Sonnet, tắt thinking, effort low |
| Chờ đủ câu đầu để đưa sang TTS | ~0,35s | Plugin Soniox chỉ gửi câu hoàn chỉnh |
| Soniox TTS ra tiếng đầu | ~0,6s | |
| Đường truyền âm thanh | ~0,5s | iPhone/máy ↔ LiveKit Ấn Độ ↔ agent trong WSL |

Agent log sẵn từng chặng: các dòng `Độ trễ user`, `Độ trễ LLM`, `Độ trễ assistant`.

Trước khi bỏ Voyage khỏi đường nóng: trung vị ~3,8s (embedding câu hỏi 0,4–1,2s).

## Đã thử, không hiệu quả (đừng thử lại)

| Thử | Kết quả |
|---|---|
| Haiku 5.5 thay Sonnet 5.5 | Chữ đầu như nhau (~0,7s), chất lượng kém hơn |
| Mở sẵn kết nối HTTPS tới Claude đầu mỗi phiên | Chênh lệch nằm trong mức dao động |
| Soniox `endpoint_latency_adjustment_level` 2 và 3 | Không nhanh hơn; mức 3 cắt ngang câu ("1 tuần." / "Có bao nhiêu ngày?") |

Cấu hình hiện tại đã tách lượt khi anh ngừng 0,4s giữa câu, nên không nên chốt lượt nhanh hơn nữa.

## Còn làm được: đều phải đánh đổi

Thứ tự theo mức giảm ước tính. Các con số là ước tính từ bảng trên, chưa làm thử.

### 1. Gọi Claude sớm, trước khi Soniox chốt lượt (giảm 0,7–1s)

Khi VAD thấy anh ngừng nói và đã có chữ tạm (partial) của Soniox, gọi Claude luôn bằng chữ
tạm. Soniox chốt lượt mà chữ cuối giống chữ tạm thì dùng câu trả lời đã chạy; khác thì huỷ và
gọi lại.

- Chi phí Claude tăng: mỗi lần anh ngừng giữa câu là một lần gọi bỏ đi. Ước tính 2–3 lần.
- Code phức tạp: phải tự quản lý câu trả lời chạy trước, vì `on_user_turn_completed` đang ghi
  lượt vào DB rồi mới gọi `llm_node`. LiveKit có sẵn `preemptive_generation` nhưng đã tắt vì
  nó làm rối thứ tự ghi DB; bật lại phải sửa luồng ghi tin nhắn.
- Ký ức đã đưa hết vào prompt nên chạy trước không bị lệch ngữ cảnh.

### 2. Chạy agent trên máy chủ gần LiveKit (giảm 0,3–0,5s)

Dùng LiveKit Cloud Agents hoặc một VPS ở Singapore/Ấn Độ. Đồng thời agent vào phòng trong
~1s thay vì 3–5s, bản native không phải chờ lúc mở app.

- Tốn tiền thuê máy chủ, phải triển khai và theo dõi backend.
- Đằng nào lên App Store cũng phải làm (không thể để agent chạy trên máy anh).

### 3. Đổi dịch vụ TTS (giảm 0,3–0,4s)

Soniox TTS ra tiếng đầu ~0,6s. Một số dịch vụ khác ra tiếng đầu ~0,2–0,3s.

- Phải thử lại chất lượng giọng tiếng Việt (giọng Soniox hiện tại đã ổn).
- Thêm một nhà cung cấp, thêm một API key.

### 4. Cho Ginger mở đầu bằng một câu thật ngắn (giảm 0,2–0,3s)

Dặn trong prompt: câu đầu tiên ngắn ("Dạ.", "Dạ, Canberra anh ạ."). Câu đầu ngắn thì TTS bắt
đầu sớm hơn.

- Cách nói của Ginger thay đổi, có thể nghe máy móc nếu lần nào cũng "Dạ." trước.

### Ước tính khi kết hợp

Làm 1 + 2: còn khoảng 2s mỗi lượt. Làm thêm 3 + 4: khoảng 1,5s.
