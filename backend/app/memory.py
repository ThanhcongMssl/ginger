"""Bộ nhớ 3 tầng.

1. Ngắn hạn: N tin nhắn gần nhất của cuộc trò chuyện hiện tại.
2. Tóm tắt: mỗi cuộc trò chuyện có một bản tóm tắt; tóm tắt của các cuộc gần
   đây được đưa vào prompt để trợ lý nhớ "câu chuyện lần trước".
3. Dài hạn: sự thật về người dùng, lưu dạng vector, tìm theo độ liên quan.
"""

import asyncio
import json
import logging
import re
from uuid import UUID

from .config import settings
from .db import pool
from .llm import TZ, complete, embed

log = logging.getLogger(__name__)


# ---------- Tầng 1: tin nhắn ----------

async def get_or_create_conversation(conversation_id: UUID | None) -> UUID:
    async with pool.connection() as conn:
        if conversation_id:
            row = await (await conn.execute(
                "SELECT id FROM conversations WHERE id = %s", (conversation_id,)
            )).fetchone()
            if row:
                return row["id"]
        row = await (await conn.execute(
            "INSERT INTO conversations DEFAULT VALUES RETURNING id"
        )).fetchone()
        return row["id"]


async def add_message(conversation_id: UUID, role: str, content: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO messages (conversation_id, role, content) VALUES (%s, %s, %s)",
            (conversation_id, role, content),
        )
        await conn.execute(
            "UPDATE conversations SET updated_at = now(), "
            "title = COALESCE(title, left(%s, 80)) WHERE id = %s",
            (content if role == "user" else None, conversation_id),
        )


async def recent_messages(conversation_id: UUID, limit: int) -> list[dict]:
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            "SELECT role, content FROM ("
            "  SELECT id, role, content FROM messages WHERE conversation_id = %s"
            "  ORDER BY id DESC LIMIT %s"
            ") t ORDER BY id",
            (conversation_id, limit),
        )).fetchall()
    msgs = [{"role": r["role"], "content": r["content"]} for r in rows]
    # Claude yêu cầu tin đầu tiên là của user.
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs


# ---------- Tầng 2: tóm tắt ----------

async def recent_summaries(exclude: UUID, limit: int = 3) -> list[dict]:
    async with pool.connection() as conn:
        return await (await conn.execute(
            "SELECT summary, updated_at FROM conversations "
            "WHERE id <> %s AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT %s",
            (exclude, limit),
        )).fetchall()


async def maybe_summarize(conversation_id: UUID) -> None:
    async with pool.connection() as conn:
        count = (await (await conn.execute(
            "SELECT count(*) AS n FROM messages WHERE conversation_id = %s",
            (conversation_id,),
        )).fetchone())["n"]
        if count % settings.summarize_every != 0:
            return
        conv = await (await conn.execute(
            "SELECT summary FROM conversations WHERE id = %s", (conversation_id,)
        )).fetchone()
    new_msgs = await recent_messages(conversation_id, settings.summarize_every)
    transcript = _transcript(new_msgs)
    prompt = (
        "Cập nhật bản tóm tắt cuộc trò chuyện giữa người dùng và trợ lý.\n"
        f"Tóm tắt hiện có:\n{conv['summary'] or '(chưa có)'}\n\n"
        f"Đoạn hội thoại mới:\n{transcript}\n\n"
        "Viết lại bản tóm tắt bằng tiếng Việt, tối đa 120 từ, giữ các chủ đề, "
        "quyết định và việc còn dang dở. Chỉ trả về bản tóm tắt."
    )
    summary = await complete(prompt, max_tokens=400)
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE conversations SET summary = %s WHERE id = %s",
            (summary.strip(), conversation_id),
        )


# ---------- Tầng 3: ký ức dài hạn ----------

async def search_memories(query: str) -> list[dict]:
    [vec] = await embed([query], input_type="query")
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            "SELECT id, content, 1 - (embedding <=> %s) AS similarity "
            "FROM memories ORDER BY embedding <=> %s LIMIT %s",
            (vec, vec, settings.memory_top_k),
        )).fetchall()
    return [r for r in rows if r["similarity"] >= settings.memory_min_similarity]


EXTRACT_PROMPT = """Bạn là bộ phận ghi nhớ của một trợ lý ảo cá nhân.
Đọc đoạn hội thoại và liệt kê những sự thật BỀN VỮNG về người dùng, đáng nhớ cho
các cuộc trò chuyện sau: thông tin cá nhân, người thân, công việc, dự án,
sở thích, thói quen, kế hoạch, quyết định, cách họ muốn trợ lý trả lời.

Không ghi: kiến thức chung, nội dung câu trả lời của trợ lý, chuyện chỉ đúng
trong hôm nay, hay suy đoán mà người dùng không nói ra.

Mỗi sự thật là một câu ngắn tiếng Việt, ngôi thứ ba ("Người dùng ...").
Nếu người dùng sửa lại thông tin cũ, ghi phiên bản mới.

Ký ức đã có (để tránh trùng lặp):
{existing}

Hội thoại:
{transcript}

Trả về DUY NHẤT một mảng JSON các chuỗi, ví dụ ["Người dùng tên Công"].
Không có gì đáng nhớ thì trả về []."""


async def extract_memories(conversation_id: UUID, user_text: str, assistant_text: str) -> None:
    transcript = _transcript([
        {"role": "user", "content": user_text},
        {"role": "assistant", "content": assistant_text},
    ])
    related = await search_memories(user_text)
    existing = "\n".join(f"- {m['content']}" for m in related) or "(chưa có)"
    raw = await complete(
        EXTRACT_PROMPT.format(existing=existing, transcript=transcript), max_tokens=600
    )
    facts = _parse_json_list(raw)
    if not facts:
        return
    vectors = await embed(facts, input_type="document")
    async with pool.connection() as conn:
        for fact, vec in zip(facts, vectors):
            nearest = await (await conn.execute(
                "SELECT id, 1 - (embedding <=> %s) AS similarity FROM memories "
                "ORDER BY embedding <=> %s LIMIT 1",
                (vec, vec),
            )).fetchone()
            if nearest and nearest["similarity"] >= settings.memory_dedupe_similarity:
                # Gần như trùng → thay bằng phiên bản mới nhất (xử lý cả trường hợp sửa sai).
                await conn.execute(
                    "UPDATE memories SET content = %s, embedding = %s, updated_at = now() "
                    "WHERE id = %s",
                    (fact, vec, nearest["id"]),
                )
            else:
                await conn.execute(
                    "INSERT INTO memories (content, embedding, source_conversation_id) "
                    "VALUES (%s, %s, %s)",
                    (fact, vec, conversation_id),
                )
    log.info("Đã lưu %d ký ức", len(facts))


async def list_memories() -> list[dict]:
    async with pool.connection() as conn:
        return await (await conn.execute(
            "SELECT id, content, created_at, updated_at FROM memories ORDER BY updated_at DESC"
        )).fetchall()


async def delete_memory(memory_id: int) -> bool:
    async with pool.connection() as conn:
        cur = await conn.execute("DELETE FROM memories WHERE id = %s", (memory_id,))
        return cur.rowcount > 0


# ---------- Ghép ngữ cảnh ----------

async def build_context(conversation_id: UUID, user_text: str) -> tuple[str, list[dict]]:
    """Trả về (khối ngữ cảnh cho system prompt, danh sách tin nhắn gần nhất)."""
    # Chạy song song: tìm ký ức (gọi Voyage) là bước chậm nhất.
    memories, summaries, messages = await asyncio.gather(
        search_memories(user_text),
        recent_summaries(exclude=conversation_id),
        recent_messages(conversation_id, settings.recent_messages),
    )

    parts = []
    if memories:
        parts.append(
            "Những điều bạn biết về người dùng:\n"
            + "\n".join(f"- {m['content']}" for m in memories)
        )
    if summaries:
        parts.append(
            "Tóm tắt các cuộc trò chuyện gần đây:\n"
            + "\n".join(
                f"- ({s['updated_at'].astimezone(TZ):%d/%m/%Y}) {s['summary']}" for s in summaries
            )
        )
    return "\n\n".join(parts), messages


# ---------- Tiện ích ----------

def _transcript(msgs: list[dict]) -> str:
    names = {"user": "Người dùng", "assistant": "Trợ lý"}
    return "\n".join(f"{names[m['role']]}: {m['content']}" for m in msgs)


def _parse_json_list(raw: str) -> list[str]:
    match = re.search(r"\[.*\]", raw, re.S)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        log.warning("Không đọc được JSON ký ức: %r", raw[:200])
        return []
    return [s.strip() for s in data if isinstance(s, str) and s.strip()]
