# Trợ lý ảo cá nhân — Giai đoạn 1: chat text + bộ nhớ

```
tro-ly/
├── backend/   FastAPI + Postgres/pgvector + Claude + Voyage embeddings
└── app/       Expo (SDK 58, React Native, TypeScript)
```

## Chạy backend

```bash
cd backend
docker compose up -d                 # Postgres có sẵn pgvector, cổng 5432
cp .env.example .env                 # điền ANTHROPIC_API_KEY, VOYAGE_API_KEY, APP_TOKEN
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Agent giọng nói LiveKit (rảnh tay, ngắt lời được) chạy thành process riêng, cần
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` trong `.env` (tạo project ở
[LiveKit Cloud](https://cloud.livekit.io)):

```bash
python -m app.agent download-files   # lần đầu: tải model VAD
python -m app.agent dev
```

Bảng sẽ tự được tạo khi khởi động. Kiểm tra: `curl localhost:8000/health`.

## Chạy app

```bash
cd app
cp .env.example .env    # EXPO_PUBLIC_API_URL = IP LAN của máy chạy backend (không dùng localhost)
npm install
npx expo start          # quét QR bằng Expo Go
```

Điện thoại và máy tính cần cùng mạng Wi-Fi.

Ba cách chạy, app tự chọn chế độ giọng nói theo môi trường:

- **Expo Go:** qua WebSocket `/voice`. Chạm mic = rảnh tay (micro tắt khi Ginger nói),
  giữ mic = hold-to-talk. Không ngắt lời bằng giọng được.
- **Development build:** qua LiveKit (WebRTC có khử tiếng vọng). Micro mở suốt, nói chen
  vào là Ginger dừng lại nghe. Build cho iPhone cần tài khoản Apple Developer:

  ```bash
  npx eas-cli build --profile development --platform ios
  npx expo start --dev-client --tunnel
  ```
- **Preview (app cài thẳng, không cần máy tính chạy Metro):** JS đóng gói lúc build, địa chỉ
  backend lấy từ biến môi trường EAS, token nhập một lần trong app (lưu Keychain):

  ```bash
  npx eas-cli env:create preview --name EXPO_PUBLIC_API_URL --value https://... --visibility plaintext
  npx eas-cli build --profile preview --platform ios
  ```
- **Web (Safari trên iPhone, không cần Apple Developer):** cùng màn hình LiveKit như
  dev build (`src/livekit.web.tsx`). Backend phục vụ luôn bản web đã build ở `/`, nên cùng
  địa chỉ với API. Micro trên web cần HTTPS, dùng Tailscale Serve:

  ```bash
  cd app && npx expo export -p web     # build vào app/dist, backend đọc thẳng thư mục này
  tailscale serve --bg 8000            # chạy trên Windows: https://<máy>.<tailnet>.ts.net
  ```

  Bản web không chứa token: lần đầu mở trang, nhập `APP_TOKEN` (trình duyệt lưu lại).

## Bộ nhớ hoạt động thế nào

| Tầng | Lưu ở đâu | Đưa vào prompt khi nào |
|---|---|---|
| Ngắn hạn | `messages` | 20 tin gần nhất của cuộc trò chuyện hiện tại |
| Tóm tắt | `conversations.summary` | Tóm tắt 3 cuộc gần nhất, cập nhật sau mỗi 6 tin |
| Dài hạn | `memories` (vector 1024 chiều) | Top 8 ký ức liên quan nhất tới câu hỏi |

Sau mỗi câu trả lời, backend chạy nền (không làm chậm phản hồi):
1. Haiku trích các sự thật bền vững về anh → embed → lưu. Ký ức gần trùng (cosine ≥ 0.88) được **ghi đè** bằng bản mới, nên khi anh sửa thông tin thì trợ lý cũng cập nhật theo.
2. Cứ đủ 6 tin thì cập nhật bản tóm tắt cuộc trò chuyện.

Nút bàn phím ở góc trái chuyển sang **gõ chữ** (khi không tiện nói hoặc chỗ ồn), dùng chung
cuộc trò chuyện với chế độ nói. Nút bánh răng mở **Cài đặt**: xoá ký ức, lịch sử hoặc tất cả, và xem/xoá từng ký ức.

## API

| Method | Path | Ghi chú |
|---|---|---|
| POST | `/livekit/token` | `{conversation_id?}` → `{url, token}` vào phòng LiveKit mới, kèm agent Ginger |
| WS | `/voice` | hold-to-talk: `start` → PCM s16le → `end`; trả `transcript`, `reply_delta`, `reply` (kèm `audio_id`) |
| GET | `/voice/audio/{id}` | mp3 câu trả lời (Soniox TTS) |
| POST | `/chat` | `{message, conversation_id?}` → stream text, header `X-Conversation-Id` |
| GET | `/conversations` | danh sách cuộc trò chuyện |
| GET | `/conversations/{id}/messages` | lịch sử |
| GET | `/memories` | ký ức dài hạn |
| DELETE | `/memories/{id}` | xoá một ký ức |
| DELETE | `/memories` | xoá mọi ký ức |
| DELETE | `/conversations` | xoá mọi cuộc trò chuyện (kèm tin nhắn, tóm tắt) |
| GET | `/data/stats` | `{memories, conversations}`: số lượng cho màn Cài đặt |

Mọi endpoint (trừ `/health`) cần header `Authorization: Bearer <APP_TOKEN>`.

## Lưu ý

- `APP_TOKEN` nằm trong bundle của app, đủ an toàn khi chỉ mình anh dùng. Nếu phát hành cho người khác thì cần thay bằng đăng nhập thật.
- Prompt hệ thống đã yêu cầu trả lời theo kiểu văn nói, không markdown, để giai đoạn 3 chỉ việc đưa thẳng text vào TTS.
- Muốn đổi model embedding thì phải đổi luôn `VECTOR(1024)` trong `schema.sql`.

## Tiếp theo

- Thử LiveKit trên iPhone; nếu ổn thì bỏ đường WebSocket `/voice` cũ.
