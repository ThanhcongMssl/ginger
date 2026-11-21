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

from . import chat_models
from .config import settings
from .db import pool
from .llm import TZ, PromptContext, complete, embed

log = logging.getLogger(__name__)


# ---------- Tầng 1: tin nhắn ----------

async def get_or_create_conversation(user_id: UUID, conversation_id: UUID | None) -> UUID:
    """Cuộc trò chuyện của đúng tài khoản này; ID lạ hoặc của người khác thì mở cuộc mới."""
    async with pool.connection() as conn:
        if conversation_id:
            row = await (await conn.execute(
                "SELECT id FROM conversations WHERE id = %s AND user_id = %s",
                (conversation_id, user_id),
            )).fetchone()
            if row:
                return row["id"]
        row = await (await conn.execute(
            "INSERT INTO conversations (user_id) VALUES (%s) RETURNING id", (user_id,)
        )).fetchone()
        return row["id"]


async def get_messages(user_id: UUID, conversation_id: UUID) -> list[dict]:
    async with pool.connection() as conn:
        return await (await conn.execute(
            "SELECT m.role, m.content, m.created_at FROM messages m "
            "JOIN conversations c ON c.id = m.conversation_id "
            "WHERE m.conversation_id = %s AND c.user_id = %s ORDER BY m.id",
            (conversation_id, user_id),
        )).fetchall()


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


async def history_window(conversation_id: UUID) -> list[dict]:
    """Lịch sử đưa vào prompt: ít nhất `recent_messages` tin, cắt bớt theo bậc 10 tin.

    Không trượt từng tin một: nếu điểm bắt đầu đổi mỗi lượt thì đầu prompt đổi theo
    và prompt cache của Claude không bao giờ trúng. Cắt theo bậc thì điểm bắt đầu giữ
    nguyên ~5 lượt liền (cửa sổ dài 20–29 tin).
    """
    minimum = settings.recent_messages
    async with pool.connection() as conn:
        n = (await (await conn.execute(
            "SELECT count(*) AS n FROM messages WHERE conversation_id = %s", (conversation_id,)
        )).fetchone())["n"]
        start = max(0, (n - minimum) // 10 * 10)
        rows = await (await conn.execute(
            "SELECT role, content FROM messages WHERE conversation_id = %s ORDER BY id OFFSET %s",
            (conversation_id, start),
        )).fetchall()
    msgs = [{"role": r["role"], "content": r["content"]} for r in rows]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs


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

async def recent_summaries(user_id: UUID, exclude: UUID, limit: int = 3) -> list[dict]:
    async with pool.connection() as conn:
        return await (await conn.execute(
            "SELECT summary, updated_at FROM conversations "
            "WHERE user_id = %s AND id <> %s AND summary IS NOT NULL "
            "ORDER BY updated_at DESC LIMIT %s",
            (user_id, exclude, limit),
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

async def search_memories(user_id: UUID, query: str) -> list[dict]:
    # Còn ít ký ức thì đưa hết vào prompt, khỏi gọi Voyage: embedding câu hỏi mất 0,4–1,2s
    # ngay trước khi gọi Claude (chặng chậm thứ hai của mỗi lượt nói). Nhiều hơn mức này
    # mới tìm theo vector.
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            "SELECT id, content FROM memories WHERE user_id = %s ORDER BY id LIMIT %s",
            (user_id, settings.memory_inline_max + 1),
        )).fetchall()
    if len(rows) <= settings.memory_inline_max:
        return rows
    [vec] = await embed([query], input_type="query")
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            "SELECT id, content, 1 - (embedding <=> %s) AS similarity "
            "FROM memories WHERE user_id = %s ORDER BY embedding <=> %s LIMIT %s",
            (vec, user_id, vec, settings.memory_top_k),
        )).fetchall()
    return [r for r in rows if r["similarity"] >= settings.memory_min_similarity]


# Cách người dùng muốn được gọi: ghi theo câu cố định để chỉ giữ lần dặn sau cùng
# (hai câu "gọi là anh" / "gọi là chị" chưa chắc đủ giống nhau để tự ghi đè theo vector).
ADDRESS_PREFIX = "Người dùng muốn được gọi là"

EXTRACT_PROMPT = """Bạn là bộ phận ghi nhớ của một trợ lý ảo cá nhân.
Đọc đoạn hội thoại và liệt kê những sự thật BỀN VỮNG về người dùng, đáng nhớ cho
các cuộc trò chuyện sau: thông tin cá nhân, người thân, công việc, dự án,
sở thích, thói quen, kế hoạch, quyết định, cách họ muốn trợ lý trả lời.

Không ghi: kiến thức chung, nội dung câu trả lời của trợ lý, chuyện chỉ đúng
trong hôm nay, hay suy đoán mà người dùng không nói ra.

Mỗi sự thật là một câu ngắn tiếng Việt, ngôi thứ ba ("Người dùng ...").
Nếu người dùng sửa lại thông tin cũ, ghi phiên bản mới.

Nếu người dùng dặn trợ lý (tên là Gừng) gọi mình thế nào, ghi đúng một câu dạng
"{address_prefix} <cách gọi>", ví dụ "{address_prefix} chị".

Ký ức đã có (để tránh trùng lặp):
{existing}

Hội thoại:
{transcript}

Trả về DUY NHẤT một mảng JSON các chuỗi, ví dụ ["Người dùng tên Công"].
Không có gì đáng nhớ thì trả về []."""


async def extract_memories(
    user_id: UUID, conversation_id: UUID, user_text: str, assistant_text: str
) -> None:
    transcript = _transcript([
        {"role": "user", "content": user_text},
        {"role": "assistant", "content": assistant_text},
    ])
    related = await search_memories(user_id, user_text)
    existing = "\n".join(f"- {m['content']}" for m in related) or "(chưa có)"
    prompt = EXTRACT_PROMPT.format(
        existing=existing, transcript=transcript, address_prefix=ADDRESS_PREFIX
    )
    raw = await complete(prompt, max_tokens=600)
    facts = _parse_json_list(raw)
    if not facts:
        return
    vectors = await embed(facts, input_type="document")
    async with pool.connection() as conn:
        if any(f.startswith(ADDRESS_PREFIX) for f in facts):
            await conn.execute(
                "DELETE FROM memories WHERE user_id = %s AND content LIKE %s",
                (user_id, ADDRESS_PREFIX + "%"),
            )
        for fact, vec in zip(facts, vectors):
            nearest = await (await conn.execute(
                "SELECT id, 1 - (embedding <=> %s) AS similarity FROM memories "
                "WHERE user_id = %s ORDER BY embedding <=> %s LIMIT 1",
                (vec, user_id, vec),
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
                    "INSERT INTO memories (user_id, content, embedding, source_conversation_id) "
                    "VALUES (%s, %s, %s, %s)",
                    (user_id, fact, vec, conversation_id),
                )
    log.info("Đã lưu %d ký ức", len(facts))


async def list_memories(user_id: UUID) -> list[dict]:
    async with pool.connection() as conn:
        return await (await conn.execute(
            "SELECT id, content, created_at, updated_at FROM memories WHERE user_id = %s "
            "ORDER BY updated_at DESC",
            (user_id,),
        )).fetchall()


async def delete_memory(user_id: UUID, memory_id: int) -> bool:
    async with pool.connection() as conn:
        cur = await conn.execute(
            "DELETE FROM memories WHERE id = %s AND user_id = %s", (memory_id, user_id)
        )
        return cur.rowcount > 0


async def delete_all_memories(user_id: UUID) -> int:
    async with pool.connection() as conn:
        cur = await conn.execute("DELETE FROM memories WHERE user_id = %s", (user_id,))
        return cur.rowcount


async def delete_all_conversations(user_id: UUID) -> int:
    """Xoá mọi cuộc trò chuyện (tin nhắn và tóm tắt xoá theo nhờ ON DELETE CASCADE)."""
    async with pool.connection() as conn:
        cur = await conn.execute("DELETE FROM conversations WHERE user_id = %s", (user_id,))
        return cur.rowcount


async def data_stats(user_id: UUID) -> dict:
    async with pool.connection() as conn:
        return await (await conn.execute(
            "SELECT (SELECT count(*) FROM memories WHERE user_id = %(u)s) AS memories, "
            "(SELECT count(*) FROM conversations WHERE user_id = %(u)s) AS conversations",
            {"u": user_id},
        )).fetchone()


# ---------- Ghép ngữ cảnh ----------

async def build_context(
    user_id: UUID, conversation_id: UUID, user_text: str
) -> tuple[PromptContext, list[dict]]:
    """Trả về (ký ức + tóm tắt để đưa vào prompt, lịch sử gần đây)."""
    # Chạy song song: tìm ký ức (gọi Voyage) là bước chậm nhất.
    from . import browser, dev  # nạp muộn: browser.py, dev.py import memory

    memories, summaries, messages, model, browser_tasks, dev_tasks = await asyncio.gather(
        search_memories(user_id, user_text),
        recent_summaries(user_id, exclude=conversation_id),
        history_window(conversation_id),
        chat_models.current(user_id),
        browser.status_for_prompt(user_id),
        dev.status_for_prompt(user_id),
    )
    tasks = "\n".join(t for t in (browser_tasks, dev_tasks) if t)

    return PromptContext(
        memories="\n".join(f"- {m['content']}" for m in memories),
        summaries="\n".join(
            f"- ({s['updated_at'].astimezone(TZ):%d/%m/%Y}) {s['summary']}" for s in summaries
        ),
        model=model,
        user_id=user_id,
        conversation_id=conversation_id,
        tasks=tasks,
    ), messages


# ---------- Sau mỗi lượt ----------

async def finish_turn(user_id: UUID, conversation_id: UUID, user_text: str, reply: str) -> None:
    """Lưu câu trả lời rồi cập nhật bộ nhớ. Chạy nền sau khi đã trả lời xong."""
    await add_message(conversation_id, "assistant", reply)
    try:
        await extract_memories(user_id, conversation_id, user_text, reply)
        await maybe_summarize(conversation_id)
    except Exception:
        log.exception("Lỗi khi cập nhật bộ nhớ")


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
