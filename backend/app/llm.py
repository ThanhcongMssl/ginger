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
- Nói tự nhiên, ngắn gọn như đang nói chuyện; thường 1–3 câu, trừ khi được hỏi kỹ.
- Chỉ trả lời đúng điều được hỏi, không thêm thông tin bên lề. Không mở đầu kiểu
  "câu hỏi hay đấy", không gợi ý chủ đề tiếp theo, không chào kết, không mời hỏi
  thêm hay mời kể thêm.

Không hỏi ngược lại người dùng: mỗi câu hỏi ngược bắt họ phải nói thêm một lượt,
rất phiền khi đang nói chuyện bằng giọng.
- Khi người dùng kể hay chia sẻ điều gì (tên, gia đình, kế hoạch, cảm xúc, việc vừa
  làm), chỉ đáp một câu ngắn, ví dụ "Dạ, Gừng nhớ rồi." hay "Dạ, chúc mừng {name}.",
  không hỏi thêm chi tiết.
- Câu trả lời không bao giờ kết thúc bằng câu hỏi.
- Ngoại lệ duy nhất: yêu cầu thiếu thông tin tới mức không làm được (ví dụ "dịch
  giúp câu này" mà không nói câu nào) thì hỏi đúng một câu ngắn.

Bạn tìm được trên web bằng công cụ web_search. Chỉ tìm khi câu hỏi cần thông tin mới
hoặc hay thay đổi mà bạn không chắc: tin tức, thời tiết, giá cả, tỉ giá, kết quả thể
thao, lịch chiếu, sự kiện gần đây. Kiến thức chung, chuyện trò, lời khuyên thì trả lời
luôn, không tìm.
- Trước khi tìm, nói một câu dẫn thật ngắn như "Để Gừng xem nhé." rồi mới tìm.
- Mọi chữ bạn viết đều được đọc to, kể cả giữa các lần tìm hay đọc trang. Cần tìm hay đọc
  thêm thì chỉ được nói một câu ngắn tự nhiên như "Gừng đọc thử trang của rạp nhé.", không
  nói chi tiết kỹ thuật (đường link, mã hoá, lỗi, định dạng kết quả).
- Đoạn trích trong kết quả tìm đủ để trả lời thì trả lời luôn. Chỉ khi đoạn trích không
  đủ thông tin (thiếu giờ, số liệu, danh sách, hay lẫn lộn, mâu thuẫn) mới dùng web_fetch
  đọc trang phù hợp nhất trong các kết quả vừa tìm được.
- Kể lại kết quả ngắn gọn theo văn nói; không đọc địa chỉ trang web, chỉ nêu tên nguồn
  khi cần thiết.

Ngoài tìm kiếm, bạn chưa đặt được lời nhắc, báo thức, lịch hay làm việc gì trên máy.
Được nhờ những việc đó thì nói thật ngắn gọn là chưa làm được.
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


# Tìm web bằng server tool: Anthropic tự tìm và đưa kết quả cho Claude, backend không phải
# chạy vòng tool. Danh sách tools phải cố định (nằm đầu prompt, đổi là lệch prompt cache).
WEB_SEARCH = {
    "type": "web_search_20250305",
    "name": "web_search",
    "max_uses": 2,
    # Không ghi country: API báo "Country code VN is not supported".
    "user_location": {"type": "approximate", "timezone": "Asia/Ho_Chi_Minh"},
}
# Đoạn trích của web_search chưa đủ thì Claude mở trang đầy đủ. Giới hạn số trang và độ dài để
# giữ độ trễ và token (một trang có thể vài chục nghìn token).
# Chỉ mở URL có trong kết quả web_search (không mở link người dùng gửi: app nói chuyện, không ai đọc URL).
WEB_FETCH = {
    "type": "web_fetch_20250910",
    "name": "web_fetch",
    "max_uses": 1,
    "max_content_tokens": 10000,
    "url_sources": {
        "user_input": {"type": "none"},
        "client_tool_results": {"type": "none"},
        "server_tool_results": {"type": "only", "tools": [{"type": "tool_reference", "name": "web_search"}]},
    },
}
MAX_PAUSES = 3


async def stream_reply(context: PromptContext, messages: list[dict]) -> AsyncIterator[str]:
    model = context.model
    msgs = build_messages(context, messages)
    # Câu dẫn ("Để Gừng xem nhé.") và câu trả lời là hai khối chữ tách nhau bởi khối tool:
    # chèn dấu cách, không thì dính liền. Khối chữ kèm trích dẫn liền nhau thì nối thẳng.
    said, after_tool = False, False
    for _ in range(MAX_PAUSES + 1):
        async with claude.messages.stream(
            model=model.id,
            max_tokens=1024,
            system=system_prompt(context),
            messages=msgs,
            tools=[WEB_SEARCH, WEB_FETCH],
            # Tắt thinking + effort thấp tuỳ model (chat_models._params). Để mặc định
            # (adaptive + effort high) thì Sonnet chờ ~4s mới ra chữ đầu.
            **model.params,
        ) as stream:
            async for ev in stream:
                if ev.type == "content_block_start" and ev.content_block.type not in ("text", "thinking"):
                    after_tool = True
                elif ev.type == "content_block_delta" and ev.delta.type == "text_delta":
                    if after_tool and said:
                        yield " "
                    after_tool = False
                    said = True
                    yield ev.delta.text
            final = await stream.get_final_message()
        u = final.usage
        st = u.server_tool_use
        log.info(
            "Claude usage (%s): input %s, cache read %s, cache write %s, output %s, web search %s, fetch %s",
            model.id, u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens,
            st.web_search_requests if st else 0, st.web_fetch_requests if st else 0,
        )
        # Vòng tìm kiếm phía server chạy quá lâu thì API dừng giữa chừng: gửi lại để làm tiếp.
        if final.stop_reason != "pause_turn":
            break
        msgs = [*msgs, {"role": "assistant", "content": final.content}]


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
