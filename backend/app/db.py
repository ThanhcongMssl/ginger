from pathlib import Path

from pgvector.psycopg import register_vector_async
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import settings

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


async def init_db() -> None:
    # Tạo extension trước, rồi mới mở pool (register_vector cần type `vector` tồn tại).
    async with await AsyncConnection.connect(settings.database_url, autocommit=True) as conn:
        await conn.execute(SCHEMA.read_text(encoding="utf-8"))
    await pool.open()


async def close_db() -> None:
    await pool.close()
