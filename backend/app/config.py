import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _req(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Thiếu biến môi trường {name} (xem .env.example)")
    return value


class Settings:
    database_url: str = _req("DATABASE_URL")
    anthropic_api_key: str = _req("ANTHROPIC_API_KEY")
    voyage_api_key: str = _req("VOYAGE_API_KEY")
    # Token tự đặt để app mobile gọi backend. Không phải API key của nhà cung cấp.
    app_token: str = _req("APP_TOKEN")

    # Model để trò chuyện chọn trong app (Cài đặt), xem chat_models.py.
    # Model rẻ, nhanh cho việc nền: trích ký ức, tóm tắt.
    utility_model: str = os.getenv("UTILITY_MODEL", "claude-haiku-5-5")
    embed_model: str = os.getenv("EMBED_MODEL", "voyage-3.5")

    user_name: str = os.getenv("USER_NAME", "anh")
    recent_messages: int = int(os.getenv("RECENT_MESSAGES", "20"))
    memory_top_k: int = int(os.getenv("MEMORY_TOP_K", "8"))
    # Tổng số ký ức không quá mức này thì đưa hết vào prompt, không cần tìm theo vector.
    memory_inline_max: int = int(os.getenv("MEMORY_INLINE_MAX", "40"))
    # Bỏ qua ký ức có độ tương đồng thấp hơn ngưỡng này (cosine similarity).
    memory_min_similarity: float = float(os.getenv("MEMORY_MIN_SIMILARITY", "0.3"))
    # Ký ức mới giống ký ức cũ hơn ngưỡng này thì cập nhật thay vì thêm mới.
    memory_dedupe_similarity: float = float(os.getenv("MEMORY_DEDUPE_SIMILARITY", "0.88"))
    # Tóm tắt lại cuộc trò chuyện sau mỗi N tin nhắn.
    summarize_every: int = int(os.getenv("SUMMARIZE_EVERY", "6"))

    # Giọng nói (Soniox). Không bắt buộc lúc khởi động để /chat vẫn chạy khi chưa có key.
    soniox_api_key: str = os.getenv("SONIOX_API_KEY", "")
    stt_model: str = os.getenv("STT_MODEL", "stt-rt-v6")
    tts_model: str = os.getenv("TTS_MODEL", "tts-rt-v2")
    tts_voice: str = os.getenv("TTS_VOICE", "Linh")

    # LiveKit (rảnh tay có khử tiếng vọng). Agent trong app/agent.py tự đọc 3 biến này.
    livekit_url: str = os.getenv("LIVEKIT_URL", "")
    livekit_api_key: str = os.getenv("LIVEKIT_API_KEY", "")
    livekit_api_secret: str = os.getenv("LIVEKIT_API_SECRET", "")

    # Thư mục bản web đã build của app.
    web_dir: str = os.getenv("WEB_DIR", str(Path(__file__).resolve().parents[2] / "app" / "dist"))


settings = Settings()
