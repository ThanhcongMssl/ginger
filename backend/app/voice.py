"""Giọng nói qua Soniox: STT real-time (WebSocket) và TTS (REST).

Luồng một lượt hold-to-talk (xem /voice trong main.py):
app gửi PCM s16le qua WebSocket → chuyển tiếp sang Soniox STT → thả nút thì chốt
transcript → Claude trả lời từng câu → Soniox TTS ra mp3 → app phát dần mp3 qua
/voice/audio/{id} ngay khi byte đầu tiên về (không chờ tổng hợp xong).
"""

import asyncio
import json
import logging
import os
import re
import uuid

import httpx
import miniaudio
from websockets.asyncio.client import ClientConnection, connect

from .config import settings

log = logging.getLogger("tro-ly.voice")

STT_URL = "wss://stt-rt.soniox.com/transcribe-websocket"
TTS_URL = "https://tts-rt.soniox.com/tts"


class SttError(Exception):
    pass


def _auth() -> dict[str, str]:
    if not settings.soniox_api_key:
        raise SttError("Chưa cấu hình SONIOX_API_KEY")
    return {"Authorization": f"Bearer {settings.soniox_api_key}"}


class SttSession:
    """Một phiên nhận dạng: mở kết nối, đẩy audio, rồi `finish()` để lấy transcript."""

    def __init__(self) -> None:
        self._ws: ClientConnection | None = None
        self._reader: asyncio.Task[str] | None = None

    async def start(self, sample_rate: int, channels: int) -> None:
        self._ws = await connect(STT_URL, additional_headers=_auth(), max_size=None)
        await self._ws.send(json.dumps({
            "model": settings.stt_model,
            "audio_format": "s16le",
            "sample_rate": sample_rate,
            "num_channels": channels,
            "language_hints": ["vi", "en"],
        }))
        self._reader = asyncio.create_task(self._collect())

    async def _collect(self) -> str:
        assert self._ws
        parts: list[str] = []
        async for raw in self._ws:
            msg = json.loads(raw)
            if msg.get("error_code"):
                raise SttError(f"Soniox {msg.get('error_type')}: {msg.get('error_message')}")
            for tok in msg.get("tokens", []):
                text = tok.get("text", "")
                if tok.get("is_final") and text not in ("<end>", "<fin>"):
                    parts.append(text)
            if msg.get("finished"):
                break
        return "".join(parts).strip()

    async def send_audio(self, chunk: bytes) -> None:
        if self._ws:
            await self._ws.send(chunk)

    async def finish(self, timeout: float = 15) -> str:
        """Báo hết audio (frame text rỗng) và chờ Soniox trả nốt các token cuối."""
        if not self._ws or not self._reader:
            return ""
        try:
            await self._ws.send("")
            return await asyncio.wait_for(self._reader, timeout)
        finally:
            # Đóng kết nối Soniox mất ~1,2s (chờ bắt tay đóng) nên cho chạy nền.
            _spawn(self.close())

    async def close(self) -> None:
        if self._reader and not self._reader.done():
            self._reader.cancel()
        ws, self._ws = self._ws, None
        if ws:
            await ws.close()


_background: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


# Soniox mặc định chỉ cho 3 request TTS đồng thời (quá thì 429). Semaphore của asyncio
# cấp lượt theo thứ tự chờ, nên câu đầu tiên luôn được tổng hợp trước.
_tts_slots = asyncio.Semaphore(int(os.getenv("TTS_MAX_CONCURRENCY", "3")))


LEVEL_RATE = 16000
LEVEL_FRAME_SEC = 0.05
LEVEL_DECODE_EVERY = 6000  # byte mp3 (~0,3s audio)


class TtsAudio:
    """mp3 của một câu, nhận dần từ Soniox. Soniox sinh audio nhanh hơn tốc độ đọc
    (byte đầu sau ~0,7s), nên app có thể phát ngay trong lúc còn đang tổng hợp."""

    def __init__(self, text: str) -> None:
        self.data = bytearray()
        # Âm lượng 0..1 theo từng khung LEVEL_FRAME_SEC, để app cho hiệu ứng nhún theo giọng.
        self.levels: list[float] = []
        self._decoded_at = 0
        self.done = False
        self.error: Exception | None = None
        self._changed = asyncio.Event()
        _spawn(self._run(text))

    async def _run(self, text: str) -> None:
        try:
            async with _tts_slots, httpx.AsyncClient(timeout=60) as client:
                async with client.stream("POST", TTS_URL, headers=_auth(), json={
                    "model": settings.tts_model,
                    "voice": settings.tts_voice,
                    "language": "vi",
                    "audio_format": "mp3",
                    "text": text,
                }) as resp:
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode(errors="replace")
                        raise RuntimeError(f"Soniox TTS {resp.status_code}: {body[:300]}")
                    async for chunk in resp.aiter_bytes():
                        self.data += chunk
                        if len(self.data) - self._decoded_at >= LEVEL_DECODE_EVERY:
                            self._update_levels(final=False)
                        self._notify()
            self._update_levels(final=True)
        except Exception as e:
            log.exception("Lỗi TTS")
            self.error = e
        finally:
            self.done = True
            self._notify()

    def _update_levels(self, final: bool) -> None:
        """Giải mã lại phần mp3 đã có (~2ms/câu) và tính RMS các khung mới."""
        self._decoded_at = len(self.data)
        try:
            pcm = miniaudio.decode(
                bytes(self.data), output_format=miniaudio.SampleFormat.SIGNED16,
                nchannels=1, sample_rate=LEVEL_RATE,
            ).samples
        except miniaudio.DecodeError:
            return
        frame = int(LEVEL_RATE * LEVEL_FRAME_SEC)
        total = len(pcm) // frame
        if not final:
            total -= 1  # khung cuối có thể chưa đủ dữ liệu
        for i in range(len(self.levels), total):
            chunk = pcm[i * frame:(i + 1) * frame]
            rms = (sum(x * x for x in chunk[::4]) / len(chunk[::4])) ** 0.5 / 32768
            # Căn bậc hai để giọng nhỏ vẫn thấy nhún; giọng nói thường rơi vào 0,3–0,8.
            self.levels.append(round(min(1.0, rms ** 0.5 * 1.5), 2))

    async def iter_levels(self):
        """Trả dần (vị trí khung bắt đầu, các giá trị mới) cho tới khi tổng hợp xong."""
        sent = 0
        while True:
            changed = self._changed
            if sent < len(self.levels):
                new = self.levels[sent:]
                yield sent, new
                sent += len(new)
                continue
            if self.done:
                return
            await changed.wait()

    def _notify(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    async def wait_done(self) -> None:
        while not self.done:
            await self._changed.wait()

    async def iter_bytes(self):
        """Phát dần từ đầu: trả phần đã có, rồi chờ thêm cho tới khi xong."""
        sent = 0
        while True:
            changed = self._changed
            if sent < len(self.data):
                chunk = bytes(self.data[sent:])
                sent += len(chunk)
                yield chunk
                continue
            if self.done:
                return
            await changed.wait()


# Hết câu: dấu câu (kèm ngoặc/nháy đóng) rồi tới khoảng trắng, hoặc xuống dòng.
_SENTENCE_END = re.compile(r'[.!?…]+["”’)\]]*\s+|\n+')


class SentenceSplitter:
    """Cắt text đang stream thành từng đoạn để đưa vào TTS.

    Gộp câu ngắn tới khi đủ `min_chars` để giọng đọc không bị cụt.
    """

    def __init__(self, min_chars: int = 20) -> None:
        self.min_chars = min_chars
        self._buf = ""

    def feed(self, text: str) -> list[str]:
        self._buf += text
        out: list[str] = []
        start = 0
        for m in _SENTENCE_END.finditer(self._buf):
            piece = self._buf[start:m.end()].strip()
            if len(piece) >= self.min_chars:
                out.append(piece)
                start = m.end()
        self._buf = self._buf[start:]
        return out

    def flush(self) -> str:
        rest, self._buf = self._buf.strip(), ""
        return rest


# Audio TTS chờ app tải về. Bắt đầu tổng hợp ngay khi có câu, app gọi GET sau.
# Không xoá sau lần tải đầu: trình phát iOS có thể gọi nhiều lần cho cùng một file.
_pending: dict[str, TtsAudio] = {}
AUDIO_TTL_SECONDS = 300


def queue_tts(text: str) -> str:
    audio_id = uuid.uuid4().hex
    _pending[audio_id] = TtsAudio(text)
    asyncio.get_running_loop().call_later(AUDIO_TTL_SECONDS, _pending.pop, audio_id, None)
    return audio_id


def get_audio(audio_id: str) -> TtsAudio | None:
    return _pending.get(audio_id)
