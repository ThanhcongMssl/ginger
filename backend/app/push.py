"""Thông báo đẩy khi việc chạy nền (trình duyệt, sửa code) xong mà anh không mở app.

Agent giọng nói đang mở phiên thì đọc kết quả trong ~2s (đánh dấu announced). Quá GRACE_SEC mà chưa đọc
(anh tắt app, hoặc đang gõ chữ) thì gửi thông báo qua Expo Push tới mọi máy của tài khoản. Anh chạm vào
thông báo → app mở, tự bắt đầu trò chuyện → agent đọc kết quả (vẫn chưa announced) và anh trả lời tiếp được.
Chạy trong backend (lifespan của main.py).
"""

import asyncio
import logging
from uuid import UUID

import httpx

from .db import pool

log = logging.getLogger("tro-ly.push")

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
GRACE_SEC = 8
POLL_SEC = 3
TABLES = ("browser_tasks", "dev_tasks")
MAX_BODY = 300


async def save_token(user_id: UUID, token: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO push_tokens (token, user_id) VALUES (%s, %s) "
            "ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = now()",
            (token, user_id),
        )


async def send(user_id: UUID, body: str) -> int:
    """Gửi tới mọi máy của tài khoản. Trả số máy gửi được; token hết hạn thì xoá."""
    async with pool.connection() as conn:
        tokens = [r["token"] for r in await (await conn.execute(
            "SELECT token FROM push_tokens WHERE user_id = %s", (user_id,))).fetchall()]
    if not tokens:
        return 0
    if len(body) > MAX_BODY:
        body = body[:MAX_BODY].rsplit(" ", 1)[0] + "…"
    msgs = [{"to": t, "title": "Gừng", "body": body, "sound": "default", "data": {"kind": "task"}} for t in tokens]
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(EXPO_PUSH_URL, json=msgs)
    r.raise_for_status()
    tickets = r.json().get("data", [])
    gone = [t for t, k in zip(tokens, tickets) if k.get("details", {}).get("error") == "DeviceNotRegistered"]
    if gone:
        async with pool.connection() as conn:
            await conn.execute("DELETE FROM push_tokens WHERE token = ANY(%s)", (gone,))
    errors = [k for k in tickets if k.get("status") != "ok"]
    if errors:
        log.warning("Expo push lỗi: %s", errors)
    return len(tickets) - len(errors)


async def loop() -> None:
    while True:
        try:
            for table in TABLES:
                async with pool.connection() as conn:
                    # Đánh dấu trước khi gửi: lỗi mạng thì bỏ lượt này, không gửi lặp.
                    rows = await (await conn.execute(
                        f"UPDATE {table} SET pushed_at = now() WHERE id IN ("
                        f"SELECT id FROM {table} WHERE NOT announced AND result IS NOT NULL "
                        "AND status IN ('done', 'waiting', 'failed') "
                        f"AND finished_at < now() - interval '{GRACE_SEC} seconds' "
                        "AND finished_at > now() - interval '2 hours' "
                        "AND (pushed_at IS NULL OR pushed_at < finished_at)) "
                        "RETURNING id, user_id, result"
                    )).fetchall()
                for row in rows:
                    n = await send(row["user_id"], row["result"])
                    log.info("Thông báo đẩy %s %s tới %d máy", table, row["id"], n)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Lỗi gửi thông báo đẩy")
        await asyncio.sleep(POLL_SEC)
