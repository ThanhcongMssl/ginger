"""Model Claude để trò chuyện: người dùng chọn dòng (Haiku / Sonnet / Opus) trong Cài đặt,
không chọn phiên bản. Bản mới nhất của mỗi dòng lấy từ Models API (nhớ 1 giờ), cách tắt
thinking cũng theo khả năng model báo về vì mỗi bản một kiểu (Sonnet 5.5 chỉ nhận
`between_tools`, Haiku 5.5 nhận `disabled`, Opus 5.5 không tắt được).

Lựa chọn lưu theo tài khoản ở DB (`users.chat_model`): agent chạy mỗi phiên trong một
process riêng.
"""

import logging
import time
from dataclasses import dataclass
from uuid import UUID

from .db import pool
from .llm import claude

log = logging.getLogger(__name__)

FAMILIES = ("haiku", "sonnet", "opus")
DEFAULT_FAMILY = "sonnet"
_TTL = 3600
# Models API lỗi thì dùng các bản này; không gửi thinking (adaptive, bản nào cũng nhận).
_FALLBACK = {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5"}


@dataclass(frozen=True)
class ChatModel:
    family: str
    id: str
    name: str
    # Tham số thêm cho messages.stream: thinking, output_config.
    params: dict


_latest: dict[str, ChatModel] = {}
_fetched_at = 0.0


def _params(caps: dict) -> dict:
    """Trả lời nói ngắn cần chữ đầu ra nhanh: tắt thinking nếu model cho tắt, effort thấp."""
    out: dict = {}
    types = caps.get("thinking", {}).get("types", {})
    if types.get("between_tools", {}).get("supported"):
        out["thinking"] = {"type": "between_tools"}
    elif types.get("disabled", {}).get("supported"):
        out["thinking"] = {"type": "disabled"}
    if caps.get("effort", {}).get("low", {}).get("supported"):
        out["output_config"] = {"effort": "low"}
    return out


async def _refresh() -> None:
    global _latest, _fetched_at
    newest = {}
    async for m in claude.models.list():
        family = next((f for f in FAMILIES if m.id.startswith(f"claude-{f}-")), None)
        if family and (family not in newest or m.created_at > newest[family].created_at):
            newest[family] = m
    _latest = {
        f: ChatModel(f, m.id, m.display_name, _params(m.capabilities.model_dump()))
        for f, m in newest.items()
    }
    _fetched_at = time.monotonic()
    log.info("Model mới nhất: %s", {f: m.id for f, m in _latest.items()})


async def available() -> dict[str, ChatModel]:
    global _fetched_at
    if time.monotonic() - _fetched_at > _TTL or not _latest:
        try:
            await _refresh()
        except Exception:
            log.exception("Không lấy được danh sách model, thử lại sau 1 phút")
            _fetched_at = time.monotonic() - _TTL + 60
    return {
        f: _latest.get(f) or ChatModel(f, _FALLBACK[f], _FALLBACK[f], {"output_config": {"effort": "low"}})
        for f in FAMILIES
    }


async def get_family(user_id: UUID) -> str:
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "SELECT chat_model FROM users WHERE id = %s", (user_id,)
        )).fetchone()
    return row["chat_model"] if row and row["chat_model"] in FAMILIES else DEFAULT_FAMILY


async def set_family(user_id: UUID, family: str) -> None:
    async with pool.connection() as conn:
        await conn.execute("UPDATE users SET chat_model = %s WHERE id = %s", (family, user_id))


async def current(user_id: UUID) -> ChatModel:
    return (await available())[await get_family(user_id)]
