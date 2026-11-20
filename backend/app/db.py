import asyncio
import logging
from pathlib import Path

from pgvector.psycopg import register_vector_async
from psycopg import AsyncConnection, OperationalError
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import settings

log = logging.getLogger(__name__)
SCHEMA = Path(__file__).resolve().parent.parent / "schema.sql"


async def _configure(conn: AsyncConnection) -> None:
    await register_vector_async(conn)
    conn.row_factory = dict_row


pool = AsyncConnectionPool(
    settings.database_url,
    min_size=1,
    max_size=10,
    open=False,
    configure=_configure,
)


DB_WAIT_SEC = 180


async def init_db() -> None:
    # Sau khi bật máy, Postgres (Docker Desktop) lên sau backend/agent: chờ thay vì lỗi luôn.
    # uvicorn --reload giữ process cha khi app lỗi khởi động nên systemd không tự chạy lại.
    deadline = asyncio.get_running_loop().time() + DB_WAIT_SEC
    while True:
        try:
            # Tạo extension trước, rồi mới mở pool (register_vector cần type `vector` tồn tại).
            async with await AsyncConnection.connect(settings.database_url, autocommit=True) as conn:
                await conn.execute(SCHEMA.read_text(encoding="utf-8"))
            break
        except OperationalError as e:
            if asyncio.get_running_loop().time() > deadline:
                raise
            log.warning("Chưa kết nối được Postgres, thử lại sau 3s: %s", str(e).splitlines()[0])
            await asyncio.sleep(3)
    await pool.open()


async def close_db() -> None:
    await pool.close()
