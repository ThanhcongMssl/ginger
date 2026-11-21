"""Thông báo đẩy khi việc chạy nền (trình duyệt, sửa code) có kết quả.

Mọi kết quả đều gửi qua Expo Push tới mọi máy của tài khoản, kể cả khi agent đã đọc lên: server không biết
chắc anh còn trong app (iOS treo app ngay khi ra nền, LiveKit còn thấy micro thêm tới ~20s; log 21/11 đọc
"đã push" vào phòng anh đã rời). App đang trò chuyện thì tự ẩn thông báo (src/push.ts), ra nền thì iOS hiện.
Chưa được đọc thì chạm vào thông báo → app mở, tự trò chuyện → agent đọc kết quả. Chạy trong lifespan backend.
"""

import asyncio
import logging
from uuid import UUID

import httpx

from .db import pool

log = logging.getLogger("tro-ly.push")

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
RECEIPT_DELAY_SEC = 15  # Expo cần vài giây mới có biên nhận từ APNs
GRACE_SEC = 1
MAX_AGE = "10 minutes"  # backend khởi động lại thì không gửi bù kết quả cũ hơn
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
    ids = [k["id"] for k in tickets if k.get("id")]
    if ids:
        _receipt_tasks.add(t := asyncio.create_task(_check_receipts(ids)))
        t.add_done_callback(_receipt_tasks.discard)
    return len(tickets) - len(errors)


_receipt_tasks: set[asyncio.Task] = set()


async def _check_receipts(ids: list[str]) -> None:
    """Ticket ok chỉ là Expo đã nhận; biên nhận mới cho biết APNs có giao không (key APNs sai, máy gỡ app…)."""
    receipts: dict = {}
    try:
        for delay in (RECEIPT_DELAY_SEC, 45, 120):  # Expo có biên nhận sau vài giây tới vài phút
            await asyncio.sleep(delay)
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.post(EXPO_RECEIPTS_URL, json={"ids": [i for i in ids if i not in receipts]})
            receipts.update(r.json().get("data", {}))
            if len(receipts) == len(ids):
                break
    except Exception:
        log.exception("Không lấy được biên nhận Expo push")
    bad = {i: v for i, v in receipts.items() if v.get("status") != "ok"}
    if bad:
        log.warning("APNs không nhận thông báo: %s", bad)
    if len(receipts) < len(ids):
        log.warning("Expo chưa có biên nhận cho %d/%d thông báo", len(ids) - len(receipts), len(ids))
    elif not bad:
        log.info("APNs đã nhận %d thông báo", len(ids))


async def loop() -> None:
    while True:
        try:
            for table in TABLES:
                async with pool.connection() as conn:
                    # Đánh dấu trước khi gửi: lỗi mạng thì bỏ lượt này, không gửi lặp.
                    rows = await (await conn.execute(
                        f"UPDATE {table} SET pushed_at = now() WHERE id IN ("
                        f"SELECT id FROM {table} WHERE result IS NOT NULL "
                        "AND status IN ('done', 'waiting', 'failed') "
                        f"AND finished_at < now() - interval '{GRACE_SEC} seconds' "
                        f"AND finished_at > now() - interval '{MAX_AGE}' "
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
