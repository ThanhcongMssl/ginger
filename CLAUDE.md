# Ginger — trợ lý ảo cá nhân bằng giọng nói tiếng Việt

Người dùng là Công, senior front-end dev (Next.js, React, TypeScript). Trao đổi bằng
tiếng Việt, gọi người dùng là "anh", xưng "em".

## Mục tiêu
App mobile trợ lý ảo dựa trên AI:
- Trả lời câu hỏi về mọi chủ đề
- Có bộ nhớ, luôn nắm được các câu chuyện trước đó
- Giao tiếp bằng giọng nói tiếng Việt

## Các quyết định đã chốt
- **Nền tảng:** app mobile, dùng React Native + Expo (SDK 58), TypeScript
- **Dùng API trả phí, không tự host model:**
  - LLM: Claude (`claude-sonnet-5-5` để chat, `claude-haiku-5-5` cho việc nền)
  - Embedding: Voyage AI `voyage-3.5` (1024 chiều)
  - Giọng nói (giai đoạn 3): STT bằng Soniox; TTS bằng Soniox hoặc Vbee/FPT.AI nếu cần giọng Việt tự nhiên hơn
- **Kiến trúc pipeline:** STT → LLM + bộ nhớ → TTS. Không dùng model speech-to-speech
  vì đắt và khó kiểm soát bộ nhớ.
- **Backend:** FastAPI + Postgres/pgvector. App không chứa API key của nhà cung cấp nào;
  app gọi backend bằng `APP_TOKEN` tự đặt.
- Câu trả lời viết theo văn nói, không markdown, để đưa thẳng vào TTS.

## Bộ nhớ 3 tầng (backend/app/memory.py)
1. Ngắn hạn: 20–29 tin gần nhất của cuộc trò chuyện hiện tại (cắt theo bậc 10 tin để prompt cache trúng)
2. Tóm tắt: mỗi cuộc có một bản tóm tắt, cập nhật sau mỗi 6 tin; đưa tóm tắt 3 cuộc gần nhất vào prompt
3. Dài hạn: sau mỗi lượt, Haiku trích các sự thật về người dùng → embed → lưu vào
   bảng `memories`. Ký ức có cosine ≥ 0.88 với ký ức cũ thì ghi đè lên ký ức cũ.
   Khi chat, lấy top 8 ký ức liên quan.
Việc cập nhật bộ nhớ chạy trong BackgroundTask sau khi stream xong.

## Prompt caching (backend/app/llm.py)
Thứ tự prompt: system (persona + tóm tắt các cuộc trước, không đổi trong một cuộc)
→ lịch sử (mốc `cache_control` ở tin cuối) → tin mới nhất kèm khối `<ngữ_cảnh>`
(giờ hiện tại + ký ức liên quan). Không đưa thứ gì đổi theo lượt lên trước lịch sử.
Log `Claude usage: ...` để kiểm tra cache read/write.

## Tiến độ
- [x] Bước 1: backend chat stream + bộ nhớ. Đã test end-to-end trên Postgres thật,
      Claude/Voyage giả lập. Chưa gọi API thật.
- [x] Bước 2: app Expo có màn hình chat (stream qua `expo/fetch`), nút "Mới" và
      màn hình "Ký ức" để xem/xoá. Đã pass `tsc` và đóng gói Android được.
      Chưa chạy trên điện thoại thật.
- [x] Chạy thử với API key thật: `/chat` + trích ký ức chạy OK; app chạy trên iPhone qua Expo Go.
- [~] Bước 3: hold-to-talk. Đã bỏ UI chat text. `useAudioStream` (PCM int16 16 kHz) →
      WebSocket `/voice` → Soniox STT real-time (`stt-rt-v6`) → Claude + bộ nhớ →
      Soniox TTS (`tts-rt-v2`, mp3) → app phát qua `GET /voice/audio/{id}`.
      Đã test trọn vòng bằng script với key thật (giọng `Linh`); chưa thử trên điện thoại.
      Độ trễ sau khi thả nút (đo bằng script): transcript ~0,3s, chữ đầu ~1,6–2s,
      byte audio đầu ~2,6–3,2s. Đã có: TTS theo từng câu, phát dần mp3 khi Soniox đang
      tổng hợp (StreamingResponse), Claude tắt thinking + effort low, đóng STT chạy nền.
- [~] Bước 4, nấc 1 (rảnh tay, half-duplex): chạm mic = rảnh tay, giữ mic = hold-to-talk.
      Soniox `enable_endpoint_detection` chốt lượt (~0,3–0,4s sau khi ngừng nói); một
      WebSocket `/voice` nhiều lượt, sự kiện kèm `turn`; micro tắt khi Ginger nói, phát xong
      tự nghe tiếp; chạm mic lúc Ginger nói = ngắt lời; im 20s thì tự thoát.
      Đã test bằng script với key thật; chưa thử trên điện thoại.
- [ ] Bước 4, nấc 2: ngắt lời bằng giọng (cần AEC → native module + dev build, hoặc LiveKit).
      Cân nhắc LiveKit (có SDK React Native + agent Python) để xử lý chống vọng tiếng.

## Môi trường dev
- Code chạy trong WSL trên Windows
- Điện thoại thường không vào thẳng được IP của WSL:
  - Expo: chạy `npx expo start --tunnel`
  - Backend: mở port 8000 bằng WSL mirrored networking, hoặc `netsh interface portproxy`
- Postgres chạy bằng `docker.exe compose up -d` (Docker Desktop, chưa bật WSL integration)
- Điện thoại gọi backend qua Tailscale: `EXPO_PUBLIC_API_URL=http://<IP Tailscale của máy Windows>:8000`
  (giá trị thật nằm trong `app/.env`),
  Windows `netsh portproxy` 8000 → IP WSL (đổi sau mỗi lần reboot)
- Expo CLI đăng nhập bằng `EXPO_TOKEN` trong `~/.zshrc`; chạy `npx expo start --tunnel`
- API key (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SONIOX_API_KEY`) do anh tự điền vào `backend/.env`.
  Không tự điền hay in key ra.

## Quy ước
- Expo: luôn dùng `npx expo install`; tra docs đúng phiên bản SDK (xem app/AGENTS.md)
- Chạy `npx tsc --noEmit` trước khi báo xong
- UI và prompt viết bằng tiếng Việt
