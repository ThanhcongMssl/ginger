"""Agent giọng nói trên LiveKit: rảnh tay, ngắt lời được bằng giọng.

LiveKit (WebRTC) lo vận chuyển audio, và khử tiếng vọng + khử ồn ngay trên điện thoại,
nên micro mở suốt cả lúc Ginger nói. Agent này:
- nghe bằng Soniox STT, chốt lượt theo endpoint của Soniox (LiveKit chưa có mô hình
  turn detection cho tiếng Việt);
- trả lời bằng Claude + bộ nhớ 3 tầng (tự viết `llm_node`, giữ nguyên prompt caching);
- đọc bằng Soniox TTS (stream qua WebSocket);
- khi người dùng nói chen vào: dừng đọc (VAD Silero phát hiện tiếng nói) và chỉ lưu phần
  câu trả lời đã kịp đọc.

Chạy (cần LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET trong .env):
    python -m app.agent download-files   # lần đầu: tải model VAD
    python -m app.agent dev
"""

import asyncio
import json
import logging
import time
from uuid import UUID

from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    ConversationItemAddedEvent,
    JobContext,
    JobProcess,
    ModelSettings,
    UserStateChangedEvent,
    cli,
    llm,
)
from livekit.plugins import silero, soniox

from . import chat_models, memory
from .config import settings
from .db import init_db
from .llm import FALLBACK_REPLY, stream_reply

log = logging.getLogger("tro-ly.agent")

AGENT_NAME = "ginger"
# Im lặng lâu như vậy thì kết thúc cuộc gọi (STT tính tiền theo phút audio).
AWAY_TIMEOUT_SEC = 20


class _NoLLM(llm.LLM):
    """AgentSession bắt buộc có LLM mới chịu trả lời, nhưng `Ginger.llm_node` tự gọi
    Claude nên LLM này không bao giờ được dùng."""

    def chat(self, **kwargs):  # type: ignore[override]
        raise NotImplementedError


class Ginger(Agent):
    def __init__(self, user_id: UUID, conversation_id: UUID) -> None:
        # Persona nằm trong llm.system_prompt, không dùng instructions của LiveKit.
        super().__init__(instructions="")
        self.user_id = user_id
        self.conversation_id = conversation_id
        self.last_user_text = ""

    async def on_user_turn_completed(self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage) -> None:
        # Chạy đúng một lần mỗi lượt (đã tắt preemptive generation), trước llm_node.
        self.last_user_text = new_message.text_content or ""
        await memory.add_message(self.conversation_id, "user", self.last_user_text)

    async def llm_node(self, chat_ctx: llm.ChatContext, tools: list, model_settings: ModelSettings):
        # Lịch sử lấy từ DB (không dùng chat_ctx của LiveKit) để prompt giống hệt các
        # lượt trước → prompt cache của Claude trúng.
        t0 = time.monotonic()
        context, messages = await memory.build_context(
            self.user_id, self.conversation_id, self.last_user_text
        )
        t_ctx = time.monotonic()
        t_first = None
        try:
            async for chunk in stream_reply(context, messages):
                t_first = t_first or time.monotonic()
                yield chunk
            log.info(
                "Độ trễ LLM: ngữ cảnh %.2fs, chữ đầu +%.2fs, xong +%.2fs",
                t_ctx - t0, (t_first or t_ctx) - t_ctx, time.monotonic() - t_ctx,
            )
        except Exception:
            log.exception("Lỗi khi gọi LLM")
            yield FALLBACK_REPLY


_db_ready = False


async def _ensure_db() -> None:
    # Mỗi job chạy trong process riêng nên phải mở pool Postgres trong process đó.
    global _db_ready
    if not _db_ready:
        await init_db()
        _db_ready = True


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


# Giữ sẵn 1 process đã nạp VAD để phiên mới không phải chờ khởi động (~5s).
server = AgentServer(setup_fnc=prewarm, num_idle_processes=1)


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    await _ensure_db()
    # Mỗi phiên là một process mới: lấy sẵn danh sách model trong lúc chờ anh nói câu đầu.
    _spawn(chat_models.available())
    meta = json.loads(ctx.job.metadata or "{}")
    # Backend (/livekit/token) đã xác định tài khoản theo mã thiết bị và ghi vào metadata.
    user_id = UUID(meta["user_id"])
    conv_id = await memory.get_or_create_conversation(
        user_id, UUID(meta["conversation_id"]) if meta.get("conversation_id") else None
    )
    agent = Ginger(user_id, conv_id)

    session = AgentSession(
        stt=soniox.STT(params=soniox.STTOptions(
            model=settings.stt_model,
            language_hints=["vi", "en"],
            # Bằng đúng tần số audio LiveKit đưa vào (room_io mặc định 24 kHz). Để 16 kHz thì
            # plugin phải resample, bộ resample giữ lại ~1s audio → chốt lượt chậm thêm ~1,1s.
            sample_rate=24000,
            # Mặc định plugin chờ tới 2s sau khi ngừng nói mới chốt lượt; 500ms là mức thấp nhất.
            max_endpoint_delay_ms=500,
            # Bản WebSocket cũ không bật nhận diện ngôn ngữ và chốt lượt nhanh hơn.
            enable_language_identification=False,
        )),
        tts=soniox.TTS(model=settings.tts_model, language="vi", voice=settings.tts_voice),
        llm=_NoLLM(),
        vad=ctx.proc.userdata["vad"],
        turn_handling={
            "turn_detection": "stt",
            # Soniox đã chờ ngừng nói rồi mới báo endpoint, không cần chờ thêm.
            "endpointing": {"min_delay": 0.0},
            # Ghi lượt vào DB ở on_user_turn_completed; chạy LLM sớm sẽ làm rối thứ tự.
            "preemptive_generation": {"enabled": False},
            # Ngắt lời bằng VAD ngay trên server. Chế độ "adaptive" (mặc định) gửi audio lên
            # LiveKit Cloud để mô hình quyết định, từ VN hay bị quá thời gian → trễ vài giây.
            # Tiếng "ừ", "à" ngắn hơn min_duration không tính là ngắt lời. VAD dễ nhầm tiếng ồn
            # là giọng nói (Ginger dừng rồi 2s sau đọc tiếp), nên phải chờ STT nghe ra ít nhất
            # 1 chữ mới ngắt; app đã tự hạ giọng Ginger trong lúc chờ (app/src/ducking.ts).
            "interruption": {"mode": "vad", "min_duration": 0.4, "min_words": 1},
        },
        user_away_timeout=AWAY_TIMEOUT_SEC,
        # Giữ mặc định aec_warmup_duration=3s: chỉ áp dụng MỘT lần mỗi phiên, tính từ câu trả lời
        # đầu tiên (không phải mỗi câu). Lúc đó khử tiếng vọng của điện thoại chưa ổn định, tiếng
        # Ginger vọng về agent trễ 1–2s; để 1s thì Ginger nghe nhầm chính mình thành lời anh nói.
    )

    @session.on("conversation_item_added")
    def _on_item(ev: ConversationItemAddedEvent) -> None:
        item = ev.item
        if not isinstance(item, llm.ChatMessage):
            return
        # Độ trễ từng chặng do LiveKit đo (giây): xem mục "Độ trễ" trong CLAUDE.md.
        m = {k: round(v, 2) for k, v in item.metrics.items() if k.endswith(("_delay", "_ttft", "_ttfs", "_ttfb"))}
        if m:
            log.info("Độ trễ %s: %s", item.role, m)
        if item.role != "assistant":
            return
        # Bị ngắt lời thì LiveKit chỉ giữ phần đã kịp đọc.
        text = (item.text_content or "").strip() or "…"
        _spawn(memory.finish_turn(user_id, conv_id, agent.last_user_text, text))
        # Gửi ID cuộc trò chuyện để lần sau app nối tiếp đúng cuộc này.
        _spawn(ctx.room.local_participant.set_attributes({"conversation_id": str(conv_id)}))

    @session.on("user_state_changed")
    def _on_user_state(ev: UserStateChangedEvent) -> None:
        if ev.new_state == "away":
            log.info("Người dùng im lặng %ss, kết thúc phiên", AWAY_TIMEOUT_SEC)
            ctx.shutdown("user away")

    await session.start(agent=agent, room=ctx.room)
    await ctx.room.local_participant.set_attributes({"conversation_id": str(conv_id)})


_background: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    cli.run_app(server)
