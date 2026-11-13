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
   Khi chat: tổng số ký ức ≤ 40 (`MEMORY_INLINE_MAX`) thì đưa hết vào prompt, không gọi Voyage
   (embedding câu hỏi mất 0,4–1,2s ngay trước Claude); nhiều hơn thì lấy top 8 ký ức liên quan.
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
- [~] Bước 4, nấc 2: ngắt lời bằng giọng qua LiveKit Cloud (anh đã chọn; có tài khoản Apple
      Developer để làm dev build). `backend/app/agent.py`: AgentSession với Soniox STT/TTS
      (plugin), chốt lượt bằng endpoint của Soniox (`turn_detection="stt"`, LiveKit chưa có
      turn detector tiếng Việt), Silero VAD cho ngắt lời, `llm_node` tự gọi Claude + bộ nhớ.
      Khi bị ngắt, lưu phần đã đọc; tin user liền nhau được gộp trong `llm.build_messages`.
      `POST /livekit/token` cấp token + dispatch agent `ginger`, conversation_id đi theo
      metadata. App: `src/LiveVoice.tsx` (dev build) / `src/ExpoGoVoice.tsx` (Expo Go, nấc 1),
      `App.tsx` chọn theo `Constants.executionEnvironment`.
      Đã test trọn vòng bằng client Python giả làm app (key LiveKit thật, region India South):
      hỏi → trả lời, nói chen vào → Ginger dừng (~1,1s), lưu phần đã đọc, trả lời câu mới.
      Chỉnh đã làm (đo được): STT `sample_rate=24000` khớp room_io (để 16k thì resampler giữ
      ~1s audio → chốt lượt chậm thêm 1,1s); `max_endpoint_delay_ms=500`; tắt language ID;
      ngắt lời mode "vad" (mode "adaptive" gọi LiveKit Cloud bị timeout 0,8s rồi mới rơi về VAD);
      `num_idle_processes=1`. `aec_warmup_duration` giữ mặc định 3s: chỉ khoá
      ngắt lời một lần mỗi phiên (câu trả lời đầu), đã thử 1s thì Ginger nghe nhầm tiếng
      mình vọng lại thành lời anh ("Dạ, em nghe đây") ở câu trả lời đầu tiên.
      Chưa build/thử trên iPhone.
- [~] Bản web (Safari, chờ Apple duyệt gói Developer): `LiveVoice.tsx` dùng chung, phần khác
      nhau nằm ở `src/livekit.tsx` / `src/livekit.web.tsx` và `src/config.ts` / `config.web.ts`.
      `npx expo export -p web` → `app/dist`, FastAPI mount ở `/` (cùng origin, không CORS).
      Token không đóng gói vào bản web: `TokenGate` hỏi một lần, lưu localStorage.
      Đã test trọn vòng bằng Chromium headless (micro giả từ file wav): hỏi → trả lời.
      HTTPS qua `tailscale serve` trên Windows. Anh đã dùng trên iPhone: ngắt lời bằng giọng OK.
- Ngắt lời mượt (`src/ducking.ts`): micro to hơn 3× ồn nền (ồn nền đo liên tục) trong 200ms
  là app hạ giọng Ginger xuống 25% trong ~0,2s; thôi nói 0,8s thì to lại. Server chỉ ngắt
  khi STT nghe ra ≥1 chữ (`min_words: 1`, để tiếng ồn không làm Ginger dừng rồi đọc tiếp);
  đo bằng Chromium + file ồn: ồn/lạch cạch không ngắt, nói chen trong ồn thì ngắt sau ~2s.
  Web cần `webAudioMix` (Safari iOS bỏ qua audio.volume) với AudioContext tạo ngay lúc chạm mic;
  âm lượng micro tính RMS tuyến tính (`useAudioLevel`) cho cùng thang với native.
- Cài đặt (`src/Settings.tsx`, nút bánh răng ở header, khoá khi đang trò chuyện): xoá ký ức /
  lịch sử / tất cả, bấm 2 lần để xác nhận (Alert không chạy trên web); bấm vào dòng "Ký ức về anh" mở
  trang danh sách ký ức, nút ✕ xoá từng điều (bấm 1 lần, cho trường hợp Ginger nhớ nhầm). Đã test bằng DB tạm.
- Bắt đầu nhanh (web): agent vào phòng mất 3–5s (kết nối từ WSL tới LiveKit India South, đo
  bằng script riêng vẫn 3–4s; gọi agent bằng API dispatch còn chậm hơn ~2s nên không dùng).
  Bản web bật `preConnectBuffer`: micro thu ngay khi kết nối, app hiện "đang nghe" sau ~1s,
  agent vào thì nhận lại phần đã nói (Opus/webm; trình duyệt không ghi được webm thì tắt).
  Native không có MediaRecorder nên vẫn chờ agent. Agent không được gọi `ctx.connect()` trước
  `session.start` (sẽ lỡ bộ đệm). App báo lỗi nếu 15s chưa thấy agent.
  Đã test bằng Chromium: nói ngay khi chạm mic, agent vào sau 5s vẫn nghe đúng câu hỏi.
- Bản preview (`eas build --profile preview`, internal distribution, JS đóng gói sẵn): `app/.env`
  không lên EAS (gitignore), nên `EXPO_PUBLIC_API_URL` nằm ở biến môi trường EAS `preview`
  (không ghi vào eas.json vì repo public). Token không đóng gói: `TokenGate` hỏi một lần, lưu
  Keychain (`expo-secure-store`, nạp lười để dev build cũ không lỗi). Đổi địa chỉ backend thì
  `eas env:update` rồi build lại.
- Tự rảnh tay (native): mở app hoặc quay lại app (AppState 'active') là tự bắt đầu trò chuyện,
  sang app khác ('background') thì kết thúc. Web vẫn phải chạm mic (Safari cần chạm mới phát
  được âm thanh). Chuyển từ chế độ gõ chữ về thì không tự bắt đầu.
- Độ trễ mỗi lượt nói: trung vị ~3,0s (từ 3,8s, nhờ bỏ Voyage khỏi đường nóng). Chi tiết từng
  chặng, những gì đã thử không ăn thua và các hướng còn lại (kèm đánh đổi): `docs/do-tre.md`.
- Chế độ gõ chữ (`src/ChatScreen.tsx`, nút bàn phím ở góc trái header; nút micro để quay lại):
  stream qua `POST /chat`. Hai chế độ dùng chung cuộc trò chuyện (`src/conversation.ts`),
  mở chat thì tải lại tin của cuộc đang mở (cả lượt nói). Web: Enter gửi, Shift+Enter xuống dòng.
  Đang trả lời thì nút gửi thành nút dừng (AbortController); backend vẫn lưu phần đã trả lời
  (uvicorn báo ASGI 2.3 nên Starlette huỷ stream rồi vẫn chạy BackgroundTask).
  Đã test bằng Chromium với Claude thật.
      Cân nhắc LiveKit (có SDK React Native + agent Python) để xử lý chống vọng tiếng.

## Môi trường dev
- Code chạy trong WSL trên Windows
- Điện thoại thường không vào thẳng được IP của WSL:
  - Expo: chạy `npx expo start --tunnel`
  - Backend: mở port 8000 bằng WSL mirrored networking, hoặc `netsh interface portproxy`
- Postgres chạy bằng `docker.exe compose up -d` (Docker Desktop, chưa bật WSL integration)
- Điện thoại gọi backend qua Tailscale Serve (HTTPS, dev build bị ATS chặn http):
  `EXPO_PUBLIC_API_URL=https://<máy>.<tailnet>.ts.net` (`tailscale serve --bg 8000` trên Windows)
  (giá trị thật nằm trong `app/.env`),
  Windows `netsh portproxy` 8000 → IP WSL (đổi sau mỗi lần reboot)
- Expo CLI đăng nhập bằng `EXPO_TOKEN` trong `~/.zshrc`; chạy `npx expo start --tunnel`
  (dev build: thêm `--dev-client`)
- Agent LiveKit: `python -m app.agent dev` (process riêng, cạnh uvicorn); cần `LIVEKIT_URL`,
  `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` trong `backend/.env` — anh tự điền.
- API key (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SONIOX_API_KEY`) do anh tự điền vào `backend/.env`.
  Không tự điền hay in key ra.

## Quy ước
- Expo: luôn dùng `npx expo install`; tra docs đúng phiên bản SDK (xem app/AGENTS.md)
- Chạy `npx tsc --noEmit` và `npx expo lint` trước khi báo xong. `expo lint` chỉ quét
  `src/` (không quét App.tsx ở gốc) nên code màn hình đặt trong `src/`.
- UI và prompt viết bằng tiếng Việt
