"""Tài khoản theo thiết bị.

App tự sinh một mã thiết bị (UUID ngẫu nhiên, lưu Keychain dùng chung cho Ginger và Ginger
Dev; web lưu localStorage) và gửi kèm mọi request qua header `X-Device-Id`. Thiết bị lần đầu
gọi tới thì được tạo tài khoản mới. Mã thiết bị là UUID v4 (122 bit ngẫu nhiên) nên không
đoán được; ngoài ra vẫn phải có APP_TOKEN.

Sau này đăng nhập Apple: gắn nhiều thiết bị vào cùng một `users.id` là dùng chung bộ nhớ.
"""

from uuid import UUID

from .db import pool


def parse_device_id(raw: str | None) -> str | None:
    """Chỉ nhận UUID (dạng chuẩn, chữ thường); sai định dạng thì trả None."""
    try:
        return str(UUID(raw or ""))
    except ValueError:
        return None


async def user_for_device(device_id: str) -> UUID:
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "UPDATE devices SET last_seen_at = now() WHERE id = %s RETURNING user_id", (device_id,)
        )).fetchone()
        if row:
            return row["user_id"]
        async with conn.transaction():
            user = await (await conn.execute("INSERT INTO users DEFAULT VALUES RETURNING id")).fetchone()
            row = await (await conn.execute(
                "INSERT INTO devices (id, user_id) VALUES (%s, %s) "
                "ON CONFLICT (id) DO NOTHING RETURNING user_id",
                (device_id, user["id"]),
            )).fetchone()
            if row:
                return row["user_id"]
        # Hai request đầu tiên của cùng thiết bị chạy song song: bên kia đã tạo trước.
        await conn.execute("DELETE FROM users WHERE id = %s", (user["id"],))
        row = await (await conn.execute(
            "SELECT user_id FROM devices WHERE id = %s", (device_id,)
        )).fetchone()
        return row["user_id"]


async def get_voice_isolation(user_id: UUID) -> bool:
    """Lọc giọng xung quanh (Krisp ở agent). Tốn phút voice isolation của LiveKit Cloud."""
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "SELECT voice_isolation FROM users WHERE id = %s", (user_id,)
        )).fetchone()
    return bool(row and row["voice_isolation"])


async def set_voice_isolation(user_id: UUID, on: bool) -> None:
    async with pool.connection() as conn:
        await conn.execute("UPDATE users SET voice_isolation = %s WHERE id = %s", (on, user_id))
