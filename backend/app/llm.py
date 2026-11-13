from collections.abc import AsyncIterator
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import voyageai
from anthropic import AsyncAnthropic

from .config import settings

claude = AsyncAnthropic(api_key=settings.anthropic_api_key)
voyage = voyageai.AsyncClient(api_key=settings.voyage_api_key)

TZ = ZoneInfo("Asia/Ho_Chi_Minh")

PERSONA = """Bạn là trợ lý ảo cá nhân của {name}, trò chuyện bằng tiếng Việt.
Bạn xưng "em", gọi người dùng là "{name}".

Câu trả lời của bạn sẽ được đọc thành giọng nói, nên:
- Nói tự nhiên, ngắn gọn như đang nói chuyện; thường 1–4 câu, trừ khi được hỏi kỹ.
- Chỉ trả lời đúng trọng tâm câu hỏi. Không mở đầu kiểu "câu hỏi hay đấy", không
  hỏi lại, không gợi ý chủ đề tiếp theo, không chào kết hay mời hỏi thêm.
- Không dùng markdown, gạch đầu dòng, bảng, emoji hay ký hiệu đặc biệt.
- Viết số, đơn vị, ngày tháng theo cách đọc được.
- Không chắc thì nói thật là không chắc.

Hãy dùng những gì bạn nhớ về người dùng một cách tự nhiên, chỉ khi nó giúp câu
trả lời tốt hơn; đừng nhắc là bạn "đang tra bộ nhớ".

Bây giờ là {now} (giờ Việt Nam)."""


def system_prompt(context: str) -> str:
    d = datetime.now(TZ)
    weekday = ["Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy", "Chủ Nhật"][d.weekday()]
    now = f"{d:%H:%M}, {weekday} {d:%d/%m/%Y}"
    base = PERSONA.format(name=settings.user_name, now=now)
    return f"{base}\n\n{context}" if context else base


async def stream_reply(context: str, messages: list[dict]) -> AsyncIterator[str]:
    async with claude.messages.stream(
        model=settings.chat_model,
        max_tokens=1024,
        system=system_prompt(context),
        messages=messages,
        # Câu trả lời nói ngắn, cần nhanh: tắt thinking (Sonnet 5.5 không nhận "disabled",
        # dùng "between_tools") và effort thấp. Mặc định là adaptive + effort high → chờ ~4s.
        thinking={"type": "between_tools"},
        output_config={"effort": "low"},
    ) as stream:
        async for text in stream.text_stream:
            yield text


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
