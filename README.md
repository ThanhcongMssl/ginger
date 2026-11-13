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

Bảng sẽ tự được tạo khi khởi động. Kiểm tra: `curl localhost:8000/health`.

## Chạy app

```bash
cd app
cp .env.example .env    # EXPO_PUBLIC_API_URL = IP LAN của máy chạy backend (không dùng localhost)
npm install
npx expo start          # quét QR bằng Expo Go
```

Điện thoại và máy tính cần cùng mạng Wi-Fi.

## Bộ nhớ hoạt động thế nào

| Tầng | Lưu ở đâu | Đưa vào prompt khi nào |
|---|---|---|
| Ngắn hạn | `messages` | 20 tin gần nhất của cuộc trò chuyện hiện tại |
| Tóm tắt | `conversations.summary` | Tóm tắt 3 cuộc gần nhất, cập nhật sau mỗi 6 tin |
| Dài hạn | `memories` (vector 1024 chiều) | Top 8 ký ức liên quan nhất tới câu hỏi |

Sau mỗi câu trả lời, backend chạy nền (không làm chậm phản hồi):
1. Haiku trích các sự thật bền vững về anh → embed → lưu. Ký ức gần trùng (cosine ≥ 0.88) được **ghi đè** bằng bản mới, nên khi anh sửa thông tin thì trợ lý cũng cập nhật theo.
2. Cứ đủ 6 tin thì cập nhật bản tóm tắt cuộc trò chuyện.

Trong app, nút **Ký ức** cho xem và xoá từng điều trợ lý nhớ.

## API

| Method | Path | Ghi chú |
|---|---|---|
| WS | `/voice` | hold-to-talk: `start` → PCM s16le → `end`; trả `transcript`, `reply_delta`, `reply` (kèm `audio_id`) |
| GET | `/voice/audio/{id}` | mp3 câu trả lời (Soniox TTS) |
| POST | `/chat` | `{message, conversation_id?}` → stream text, header `X-Conversation-Id` |
| GET | `/conversations` | danh sách cuộc trò chuyện |
| GET | `/conversations/{id}/messages` | lịch sử |
| GET | `/memories` | ký ức dài hạn |
| DELETE | `/memories/{id}` | xoá một ký ức |

Mọi endpoint (trừ `/health`) cần header `Authorization: Bearer <APP_TOKEN>`.

## Lưu ý

- `APP_TOKEN` nằm trong bundle của app, đủ an toàn khi chỉ mình anh dùng. Nếu phát hành cho người khác thì cần thay bằng đăng nhập thật.
- Prompt hệ thống đã yêu cầu trả lời theo kiểu văn nói, không markdown, để giai đoạn 3 chỉ việc đưa thẳng text vào TTS.
- Muốn đổi model embedding thì phải đổi luôn `VECTOR(1024)` trong `schema.sql`.

## Tiếp theo

3. Push-to-talk: `expo-audio` ghi âm → WebSocket → STT (Soniox) → `/chat` → TTS → phát lại
4. Stream audio theo từng câu để giảm độ trễ, sau đó đến hội thoại rảnh tay (VAD, ngắt lời)
