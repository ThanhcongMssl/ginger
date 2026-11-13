import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import TYPE_CHECKING
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import voyageai
from anthropic import AsyncAnthropic

from .config import settings

if TYPE_CHECKING:
    from .chat_models import ChatModel

claude = AsyncAnthropic(api_key=settings.anthropic_api_key)
voyage = voyageai.AsyncClient(api_key=settings.voyage_api_key)

TZ = ZoneInfo("Asia/Ho_Chi_Minh")
log = logging.getLogger("tro-ly.llm")

PERSONA = """Bạn là Gừng, trợ lý ảo cá nhân, trò chuyện bằng tiếng Việt.

Xưng hô:
- Luôn tự xưng là "Gừng" (ví dụ "Dạ, Gừng nghe đây", "Để Gừng xem nhé"), không xưng
  "em", "tôi" hay "mình".
- Mặc định gọi người dùng là "{name}". Nếu người dùng muốn được gọi khác (chị, bạn,
  hay tên riêng), dù vừa dặn trong câu này hay đã có trong ký ức, thì gọi theo ý họ.
  Dặn sau cùng thì thắng.
- Các câu trả lời cũ trong lịch sử có thể xưng hô khác; không bắt chước, cứ theo quy
  tắc trên.

Câu trả lời của bạn sẽ được đọc thành giọng nói, nên:
- Nói tự nhiên, ngắn gọn như đang nói chuyện; thường 1–4 câu, trừ khi được hỏi kỹ.
- Chỉ trả lời đúng trọng tâm câu hỏi. Không mở đầu kiểu "câu hỏi hay đấy", không
  hỏi lại, không gợi ý chủ đề tiếp theo, không chào kết hay mời hỏi thêm.
- Không dùng markdown, gạch đầu dòng, bảng, emoji hay ký hiệu đặc biệt.
- Viết số, đơn vị, ngày tháng theo cách đọc được.
- Không chắc thì nói thật là không chắc.

Tin nhắn mới nhất của người dùng mở đầu bằng khối <ngữ_cảnh> do hệ thống tự thêm:
giờ hiện tại và những gì bạn nhớ về người dùng liên quan tới câu hỏi. Hãy dùng nó
cùng phần tóm tắt bên dưới một cách tự nhiên, chỉ khi giúp câu trả lời tốt hơn;
đừng nhắc tới khối này hay nói là bạn "đang tra bộ nhớ"."""


# Không gọi "anh" ở đây: người dùng có thể đã dặn gọi khác.
FALLBACK_REPLY = "Xin lỗi, Gừng đang gặp sự cố kết nối, thử lại giúp Gừng nhé."


@dataclass
class PromptContext:
    memories: str  # ký ức liên quan tới câu hỏi: đổi mỗi lượt
    summaries: str  # tóm tắt các cuộc trước: không đổi suốt một cuộc trò chuyện
    model: "ChatModel"  # model người dùng chọn trong Cài đặt (chat_models.py)


def system_prompt(ctx: PromptContext) -> str:
    # Chỉ chứa phần không đổi trong một cuộc trò chuyện để prompt cache trúng được.
    base = PERSONA.format(name=settings.user_name)
    if ctx.summaries:
        base += f"\n\nTóm tắt các cuộc trò chuyện gần đây:\n{ctx.summaries}"
    return base


def _now() -> str:
    d = datetime.now(TZ)
    weekday = ["Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy", "Chủ Nhật"][d.weekday()]
    return f"{d:%H:%M}, {weekday} {d:%d/%m/%Y}"


def build_messages(ctx: PromptContext, messages: list[dict]) -> list[dict]:
    """Sắp prompt cho prompt caching: [system cố định][lịch sử ⟵ mốc cache][ngữ cảnh + câu hỏi].

    Phần thay đổi mỗi lượt (giờ, ký ức) chỉ nằm trong tin cuối; lịch sử lấy nguyên văn
    từ DB nên lượt sau đọc lại được từ cache.
    """
    *history, last = _merge_same_role(messages)
    block = f"Bây giờ là {_now()} (giờ Việt Nam)."
    if ctx.memories:
        block += f"\n\nNhững điều bạn biết về người dùng:\n{ctx.memories}"
    out = [dict(m) for m in history]
    if out:
        out[-1]["content"] = [{
            "type": "text",
            "text": out[-1]["content"],
            "cache_control": {"type": "ephemeral"},
        }]
    out.append({"role": last["role"], "content": f"<ngữ_cảnh>\n{block}\n</ngữ_cảnh>\n\n{last['content']}"})
    return out


def _merge_same_role(messages: list[dict]) -> list[dict]:
    """Gộp các tin liền nhau cùng vai (vd. người dùng nói chen trước khi Ginger kịp nói gì)."""
    out: list[dict] = []
    for m in messages:
        if out and out[-1]["role"] == m["role"]:
            out[-1] = {**out[-1], "content": f"{out[-1]['content']}\n{m['content']}"}
        else:
            out.append(dict(m))
    return out


async def stream_reply(context: PromptContext, messages: list[dict]) -> AsyncIterator[str]:
    model = context.model
    async with claude.messages.stream(
        model=model.id,
        max_tokens=1024,
        system=system_prompt(context),
        messages=build_messages(context, messages),
        # Tắt thinking + effort thấp tuỳ model (chat_models._params). Để mặc định
        # (adaptive + effort high) thì Sonnet chờ ~4s mới ra chữ đầu.
        **model.params,
    ) as stream:
        async for text in stream.text_stream:
            yield text
        u = (await stream.get_final_message()).usage
        log.info(
            "Claude usage (%s): input %s, cache read %s, cache write %s, output %s",
            model.id, u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens,
        )


async def complete(prompt: str, max_tokens: int = 500) -> str:
    resp = await claude.messages.create(
        model=settings.utility_model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(b.text for b in resp.content if b.type == "text")


async def embed(texts: list[str], input_type: str) -> list[np.ndarray]:
    result = await voyage.embed(texts, model=settings.embed_model, input_type=input_type)
    return [np.asarray(v, dtype=np.float32) for v in result.embeddings]
