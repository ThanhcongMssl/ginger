import asyncio
import json
import logging
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from . import memory, voice
from .config import settings
from .db import close_db, init_db, pool
from .llm import stream_reply

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("tro-ly")


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    yield
    await close_db()


app = FastAPI(title="Trợ lý ảo", lifespan=lifespan)


def require_token(authorization: str = Header(default="")) -> None:
    if authorization != f"Bearer {settings.app_token}":
        raise HTTPException(status_code=401, detail="Sai token")


auth = [Depends(require_token)]


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    conversation_id: UUID | None = None


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/chat", dependencies=auth)
async def chat(req: ChatRequest):
    """Trả lời dạng stream text thuần. ID cuộc trò chuyện nằm ở header X-Conversation-Id."""
    conv_id = await memory.get_or_create_conversation(req.conversation_id)
    await memory.add_message(conv_id, "user", req.message)
    context, messages = await memory.build_context(conv_id, req.message)

    reply: list[str] = []

    async def generate():
        try:
            async for chunk in stream_reply(context, messages):
                reply.append(chunk)
                yield chunk
        except Exception:
            log.exception("Lỗi khi gọi LLM")
            reply.append(FALLBACK_REPLY)
            yield FALLBACK_REPLY

    async def after_reply():
        await finish_turn(conv_id, req.message, "".join(reply))

    return StreamingResponse(
        generate(),
        media_type="text/plain; charset=utf-8",
        headers={"X-Conversation-Id": str(conv_id), "Cache-Control": "no-cache"},
        background=BackgroundTask(after_reply),
    )


FALLBACK_REPLY = "Xin lỗi, em đang gặp sự cố kết nối. Anh thử lại giúp em nhé."


async def finish_turn(conv_id: UUID, user_text: str, reply: str) -> None:
    """Lưu câu trả lời rồi cập nhật bộ nhớ. Chạy sau khi đã trả lời xong cho app."""
    await memory.add_message(conv_id, "assistant", reply)
    try:
        await memory.extract_memories(conv_id, user_text, reply)
        await memory.maybe_summarize(conv_id)
    except Exception:
        log.exception("Lỗi khi cập nhật bộ nhớ")


# Giữ tham chiếu để task nền không bị dọn mất giữa chừng.
_background: set[asyncio.Task] = set()


def run_in_background(coro) -> None:
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


@app.websocket("/voice")
async def voice_ws(ws: WebSocket):
    """Một lượt hold-to-talk trên một kết nối.

    App → server: {"type":"start","sample_rate","channels","conversation_id"}, các frame
    binary PCM s16le, rồi {"type":"end"} khi thả nút (hoặc {"type":"cancel"}).
    Server → app: transcript, reply_delta*, reply (kèm audio_id), hoặc error.
    """
    if ws.headers.get("authorization") != f"Bearer {settings.app_token}":
        await ws.close(code=4401)
        return
    await ws.accept()

    stt = voice.SttSession()
    conversation_id: UUID | None = None
    level_tasks: list[asyncio.Task] = []
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("bytes") is not None:
                await stt.send_audio(msg["bytes"])
                continue
            data = json.loads(msg.get("text") or "{}")
            if data.get("type") == "start":
                if data.get("conversation_id"):
                    conversation_id = UUID(data["conversation_id"])
                await stt.start(int(data["sample_rate"]), int(data.get("channels", 1)))
            elif data.get("type") == "end":
                break
            elif data.get("type") == "cancel":
                return

        transcript = await stt.finish()
        if not transcript:
            await ws.send_json({"type": "error", "message": "Em chưa nghe rõ, anh nói lại nhé."})
            return
        await ws.send_json({"type": "transcript", "text": transcript})

        conv_id = await memory.get_or_create_conversation(conversation_id)
        await memory.add_message(conv_id, "user", transcript)
        context, messages = await memory.build_context(conv_id, transcript)

        # Đọc từng câu ngay khi Claude viết xong câu đó, không chờ cả câu trả lời.
        parts: list[str] = []
        splitter = voice.SentenceSplitter()
        audio_count = 0

        send_lock = asyncio.Lock()

        async def send(payload: dict) -> None:
            async with send_lock:
                await ws.send_json(payload)

        async def send_levels(index: int, audio: voice.TtsAudio) -> None:
            async for start, values in audio.iter_levels():
                await send({"type": "level", "index": index, "start": start, "values": values})

        async def speak(sentence: str) -> None:
            nonlocal audio_count
            audio_id = voice.queue_tts(sentence)
            await send({"type": "audio", "audio_id": audio_id, "index": audio_count})
            audio = voice.get_audio(audio_id)
            assert audio
            level_tasks.append(asyncio.create_task(send_levels(audio_count, audio)))
            audio_count += 1

        try:
            async for chunk in stream_reply(context, messages):
                parts.append(chunk)
                await send({"type": "reply_delta", "text": chunk})
                for sentence in splitter.feed(chunk):
                    await speak(sentence)
            if rest := splitter.flush():
                await speak(rest)
        except WebSocketDisconnect:
            raise
        except Exception:
            log.exception("Lỗi khi gọi LLM")
            parts = [FALLBACK_REPLY]
            await speak(FALLBACK_REPLY)
        reply = "".join(parts).strip()

        run_in_background(finish_turn(conv_id, transcript, reply))
        await send({
            "type": "reply",
            "text": reply,
            "conversation_id": str(conv_id),
            "audio_count": audio_count,
        })
        # Giữ kết nối tới khi gửi hết âm lượng của các câu (TTS có thể chưa xong).
        await asyncio.wait_for(asyncio.gather(*level_tasks), timeout=90)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("Lỗi ở /voice")
        try:
            await ws.send_json({"type": "error", "message": f"Lỗi: {e}"})
        except Exception:
            pass
    finally:
        for task in level_tasks:
            task.cancel()
        await stt.close()
        try:
            await ws.close()
        except Exception:
            pass


@app.get("/voice/audio/{audio_id}", dependencies=auth)
async def voice_audio(audio_id: str, range: str | None = Header(default=None)):
    audio = voice.get_audio(audio_id)
    if audio is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy audio")

    # Đang tổng hợp: phát dần (không có độ dài, không hỗ trợ Range) để AVPlayer
    # chơi như stream radio. Request Range từ giữa file thì chờ tổng hợp xong.
    range_start = 0
    if range and range.startswith("bytes="):
        start_s = range[6:].split(",")[0].partition("-")[0]
        range_start = int(start_s) if start_s else -1
    if not audio.done and range_start == 0:
        return StreamingResponse(audio.iter_bytes(), media_type="audio/mpeg")

    await audio.wait_done()
    if audio.error:
        raise HTTPException(status_code=502, detail="Lỗi tạo giọng nói")
    data = bytes(audio.data)

    # Đã có đủ file: hỗ trợ Range như file tĩnh.
    headers = {"Accept-Ranges": "bytes"}
    size = len(data)
    if range and range.startswith("bytes="):
        start_s, _, end_s = range[6:].split(",")[0].partition("-")
        start = int(start_s) if start_s else max(size - int(end_s), 0)
        end = int(end_s) if start_s and end_s else size - 1
        end = min(end, size - 1)
        if start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return Response(data[start:end + 1], status_code=206, media_type="audio/mpeg", headers=headers)
    return Response(data, media_type="audio/mpeg", headers=headers)


@app.get("/conversations", dependencies=auth)
async def list_conversations(limit: int = 30):
    async with pool.connection() as conn:
        return await (await conn.execute(
            "SELECT id, title, summary, updated_at FROM conversations "
            "ORDER BY updated_at DESC LIMIT %s",
            (limit,),
        )).fetchall()


@app.get("/conversations/{conversation_id}/messages", dependencies=auth)
async def get_messages(conversation_id: UUID):
    async with pool.connection() as conn:
        return await (await conn.execute(
            "SELECT role, content, created_at FROM messages "
            "WHERE conversation_id = %s ORDER BY id",
            (conversation_id,),
        )).fetchall()


@app.get("/memories", dependencies=auth)
async def get_memories():
    return await memory.list_memories()


@app.delete("/memories/{memory_id}", dependencies=auth)
async def remove_memory(memory_id: int):
    if not await memory.delete_memory(memory_id):
        raise HTTPException(status_code=404, detail="Không tìm thấy")
    return {"deleted": memory_id}
