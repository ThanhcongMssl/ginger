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
import re
import time
import unicodedata
from collections.abc import Callable
from uuid import UUID

from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    AgentStateChangedEvent,
    ConversationItemAddedEvent,
    JobContext,
    JobProcess,
    ModelSettings,
    UserStateChangedEvent,
    cli,
    llm,
    room_io,
    stt,
)
from livekit import rtc
from livekit.plugins import krisp, silero, soniox

from . import accounts, chat_models, memory
from .config import settings
from .db import init_db
from .llm import FALLBACK_REPLY, stream_reply
from .voice import STT_CONTEXT

log = logging.getLogger("tro-ly.agent")

AGENT_NAME = "ginger"
# Im lặng lâu như vậy thì kết thúc cuộc gọi (STT tính tiền theo phút audio).
AWAY_TIMEOUT_SEC = 20
# Báo sẵn sàng dù chưa thấy âm thanh từ micro sau chừng này giây kể từ khi phiên bắt đầu.
MIC_READY_FALLBACK_SEC = 6

# Lọc tiếng vọng: khử vọng trên điện thoại không triệt hết, STT vẫn nghe ra lời Ginger
# (vd. Ginger nói "bé Dừa ngửi mùi quen" → STT nghe "Bé giờ ngửi mùi quê") rồi tự ngắt
# lời mình. Đoạn nói bắt đầu lúc Ginger đang nói (hoặc chưa quá ECHO_START_TAIL_SEC sau
# khi thôi nói) mà phần lớn âm tiết trùng với câu Ginger vừa nói thì bỏ.
ECHO_START_TAIL_SEC = 1.0
# Giữ câu đã nói làm mẫu so thêm chừng này sau khi thôi nói (STT chốt câu trễ ~0,5–2s).
ECHO_KEEP_SEC = 3.0
ECHO_MATCH = 0.6
# Lời ngắt quen thuộc (đã bỏ dấu), đủ để dừng Ginger dù chỉ 1–2 âm tiết.
_STOP_WORDS = {"thoi", "dung", "ngung", "khoan", "stop", "im", "lai"}
_TRANSCRIPTS = (
    stt.SpeechEventType.INTERIM_TRANSCRIPT,
    stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
    stt.SpeechEventType.FINAL_TRANSCRIPT,
)


# Ginger đọc số thành chữ ("một nghìn chín trăm bốn mươi lăm") nhưng STT nghe lại ra chữ số
# ("1945", có khi vỡ thành "19.", "45."): coi mọi số là "#", khớp với bất kỳ chữ số đếm nào.
_NUMBER_WORDS = {
    "khong", "mot", "hai", "ba", "bon", "tu", "nam", "lam", "sau", "bay", "tam", "chin",
    "muoi", "tram", "nghin", "ngan", "trieu", "ty", "linh", "le", "ruoi", "phay",
}


def _syllables(text: str) -> list[str]:
    """Âm tiết bỏ dấu: tiếng vọng hay bị nghe sai dấu ("nhầm" → "nằm", "quen" → "quê")."""
    t = unicodedata.normalize("NFD", text.lower().replace("đ", "d"))
    words = re.findall(r"[a-z0-9]+", "".join(c for c in t if not unicodedata.combining(c)))
    return ["#" if w[0].isdigit() else w for w in words]


def _same(a: str, b: str) -> bool:
    if a == "#" or b == "#":
        return (a == "#" or a in _NUMBER_WORDS) and (b == "#" or b in _NUMBER_WORDS)
    # Gần đúng: thiếu/thừa một chữ cuối ("que" ≈ "quen"), chỉ với âm tiết dài.
    return a == b or (min(len(a), len(b)) >= 3 and abs(len(a) - len(b)) == 1 and (a.startswith(b) or b.startswith(a)))


def _common_in_order(a: list[str], b: list[str]) -> int:
    """Số âm tiết của a trùng với b theo đúng thứ tự (LCS). Tiếng vọng giữ thứ tự lời
    Ginger; câu người dùng nói chỉ tình cờ dùng lại vài chữ thông dụng, lộn thứ tự."""
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b):
            cur.append(prev[j] + 1 if _same(x, y) else max(prev[j + 1], cur[j]))
        prev = cur
    return prev[-1]


def is_echo(heard: str, said: str, final: bool) -> bool:
    words, ref = _syllables(heard), _syllables(said)
    if not words or not ref:
        return False
    if len(words) < 3:
        # 1–2 âm tiết chưa đủ để phân biệt, trừ lời ngắt quen thuộc ("thôi", "dừng lại")
        # mà Ginger không vừa nói: cho qua ngay để Ginger dừng nhanh.
        if all(w in _STOP_WORDS for w in words) and not any(w in ref for w in words):
            return False
        # Bản tạm: chờ thêm (ngắt lời chậm hơn một nhịp, còn hơn để Ginger tự ngắt lời mình).
        # Bản chốt một âm tiết: tiếng vọng bị nghe sai hẳn ("dời" → "Rơi", "Thăng" → "Tham").
        if not final or len(words) == 1:
            return True
        # Hai âm tiết: vọng nếu từng âm tiết là chữ Ginger vừa nói, hoặc phần đầu của chữ đó
        # (STT hay cắt cụt tiếng vọng: "Vùng" → "Vù").
        return all(any(_same(w, r) or r.startswith(w) for r in ref) for w in words)
    return _common_in_order(words, ref) / len(words) >= ECHO_MATCH


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
        # Những gì Ginger đã/đang nói gần đây, để nhận ra tiếng vọng (xem is_echo).
        self._said = ""
        self._speaking = False
        self._spoke_until = 0.0
        self._segment_may_echo = False
        # Gọi một lần khi âm thanh thật từ micro bắt đầu tới (xem _watch_mic).
        self.on_mic_ready: Callable[[], None] = lambda: None
        self._mic_ready = False

    async def _watch_mic(self, frames):
        """Báo khi âm thanh thật từ micro đầu tiên tới agent.

        Agent chuyển sang "đang nghe" ngay khi vào phòng, nhưng kết nối nhận audio của anh còn
        mất thêm 1,3–2,6s; trong lúc đó LiveKit chỉ đưa khung toàn số 0, nói gì cũng mất. Micro
        thật (kể cả lúc im) luôn có chút tiếng nền nên khung khác 0 đầu tiên = đã nhận được audio.
        """
        t0 = time.monotonic()
        async for f in frames:
            if not self._mic_ready and any(f.data):
                self._mic_ready = True
                log.info("Micro đã tới agent sau %.2fs", time.monotonic() - t0)
                self.on_mic_ready()
            yield f

    def on_agent_state(self, state: str) -> None:
        if state == "speaking":
            self._speaking = True
        elif self._speaking:
            self._speaking = False
            self._spoke_until = time.monotonic()

    def _since_spoke(self) -> float:
        return 0.0 if self._speaking else time.monotonic() - self._spoke_until

    async def stt_node(self, audio, model_settings: ModelSettings):
        async for ev in Agent.default.stt_node(self, self._watch_mic(audio), model_settings):
            if isinstance(ev, stt.SpeechEvent):
                if ev.type == stt.SpeechEventType.START_OF_SPEECH:
                    self._segment_may_echo = self._since_spoke() <= ECHO_START_TAIL_SEC
                elif ev.type in _TRANSCRIPTS and self._segment_may_echo and ev.alternatives:
                    final = ev.type == stt.SpeechEventType.FINAL_TRANSCRIPT
                    if is_echo(ev.alternatives[0].text, self._said, final):
                        if final:
                            log.info("Bỏ tiếng vọng: %r", ev.alternatives[0].text)
                        continue
            yield ev

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
        if self._since_spoke() > ECHO_KEEP_SEC:
            self._said = ""
        try:
            async for chunk in stream_reply(context, messages):
                t_first = t_first or time.monotonic()
                self._said += chunk
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
    room_opts = room_io.RoomOptions(
        # Tắt DTX cho giọng Ginger: mặc định hễ im (hết câu, ngắt giữa câu) là agent chỉ gửi gói
        # "tiếng ồn nền" (50 → 4 gói/giây), iPhone chuyển sang tự tạo tiếng nền thì kêu "bụp"
        # ngay khi dứt chữ cuối. Gửi đủ gói lúc im chỉ tốn thêm vài kbps.
        audio_output=room_io.AudioOutputOptions(
            track_publish_options=rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE, dtx=False)
        ),
    )
    if await accounts.get_voice_isolation(user_id):
        # Krisp lọc giọng người khác / nhạc (karaoke nhà bên…), giữ giọng gần micro nhất.
        # Gói free của LiveKit Cloud chỉ có 100 phút/tháng nên để người dùng tự bật trong Cài đặt.
        try:
            room_opts.audio_input = room_io.AudioInputOptions(noise_cancellation=krisp.voice_isolation())
            log.info("Bật lọc giọng xung quanh (Krisp)")
        except Exception:
            log.exception("Không bật được lọc giọng xung quanh, chạy không lọc")

    session = AgentSession(
        stt=soniox.STT(params=soniox.STTOptions(
            model=settings.stt_model,
            language_hints=["vi", "en"],
            # Cho STT biết tên "Gừng" (xem STT_CONTEXT trong voice.py).
            context=soniox.ContextObject(
                general=[soniox.ContextGeneralItem(**g) for g in STT_CONTEXT["general"]],
                text=STT_CONTEXT["text"],
                terms=STT_CONTEXT["terms"],
            ),
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

    @session.on("agent_state_changed")
    def _on_agent_state(ev: AgentStateChangedEvent) -> None:
        agent.on_agent_state(ev.new_state)

    @session.on("user_state_changed")
    def _on_user_state(ev: UserStateChangedEvent) -> None:
        if ev.new_state == "away":
            log.info("Người dùng im lặng %ss, kết thúc phiên", AWAY_TIMEOUT_SEC)
            ctx.shutdown("user away")

    def _mic_ready() -> None:
        # App giữ hiệu ứng "đang kết nối" tới khi thấy attribute này (LiveVoice.tsx).
        _spawn(ctx.room.local_participant.set_attributes({"mic_ready": "1"}))

    agent.on_mic_ready = _mic_ready

    async def _mic_ready_fallback() -> None:
        # Micro im tuyệt đối (bị tắt tiếng…) thì không bao giờ có khung khác 0: vẫn báo sẵn sàng.
        await asyncio.sleep(MIC_READY_FALLBACK_SEC)
        if not agent._mic_ready:
            log.info("Chưa thấy âm thanh từ micro sau %ss, vẫn báo sẵn sàng", MIC_READY_FALLBACK_SEC)
            agent._mic_ready = True
            _mic_ready()

    await session.start(agent=agent, room=ctx.room, room_options=room_opts)
    await ctx.room.local_participant.set_attributes({"conversation_id": str(conv_id)})
    _spawn(_mic_ready_fallback())


_background: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    cli.run_app(server)
