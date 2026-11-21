"""Gừng tự sửa mã nguồn của mình: anh nói yêu cầu, Claude Code sửa trên bản sao riêng, anh đồng ý thì áp dụng.

Luồng (cùng kiểu browser.py):
1. Lúc trò chuyện, Claude gọi tool `dev_task` (chỉ tài khoản trong DEV_USER_IDS mới có tool này):
   ghi việc vào bảng `dev_tasks`, Gừng nói một câu ngắn rồi thôi.
2. Worker (`python -m app.dev`, dịch vụ ginger-dev) clone repo ra thư mục riêng, nhánh riêng, chạy
   `claude -p` (Claude Code, tính vào gói subscription qua CLAUDE_CODE_OAUTH_TOKEN) trong sandbox bwrap.
3. Xong thì báo tóm tắt và hỏi từng bước, anh đồng ý mới làm:
   review → gộp vào main + khởi động lại dịch vụ (agent không lên thì tự quay về bản cũ)
   → ota (chỉ khi đổi app/) → push GitHub (quét thông tin riêng tư trước).

An toàn:
- Claude Code chỉ chạy trong bwrap: thấy bản clone, venv/node_modules (chỉ đọc), HOME riêng; không thấy
  repo gốc, .env, ~/.zshrc, ~/.ssh, ổ Windows, systemd, Docker.
- Sandbox không có mạng (--unshare-net): không tới được Postgres, cổng nào trên máy hay Internet. Lối ra duy
  nhất là proxy chạy trong worker này (unix socket), chỉ cho POST /v1/messages* tới api.anthropic.com và tự gắn
  token thật; trong sandbox chỉ có token giả, nên dù Claude bị nội dung lạ lừa cũng không lấy được token mang đi.
  Không cho WebFetch (mở trang lạ); WebSearch chạy phía Anthropic nên vẫn dùng được.
- Mọi bước chạm máy thật (gộp, khởi động lại, OTA, push) do code ở đây làm sau khi anh đồng ý, không
  phải Claude. Không chạy git ngoài sandbox trong bản clone (hook/config trong đó do Claude viết):
  code đi ra bằng git bundle.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import signal
import time
from asyncio.subprocess import PIPE, STDOUT
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from uuid import UUID

import httpx
from aiohttp import ClientSession, ClientTimeout, web

from . import memory
from .browser import _address
from .config import settings
from .db import init_db, pool
from .llm import TZ

log = logging.getLogger("tro-ly.dev")

REPO = Path(__file__).resolve().parents[2]
HOME = Path.home()
DATA = HOME / ".local/share/ginger-dev"
SB_HOME = DATA / "home"  # HOME của Claude Code trong sandbox (phiên để --resume nằm ở đây)
WT_ROOT = DATA / "wt"  # bản clone của từng việc
IO_ROOT = DATA / "io"  # file bundle trao đổi giữa sandbox và repo gốc
# Mẫu thông tin riêng tư không được push (mỗi dòng một regex). Nằm ngoài repo vì chính nó là thông tin riêng.
PUSH_DENY_FILE = HOME / ".config/ginger/push-deny.txt"
API_SOCK = DATA / "api.sock"  # proxy gắn token (ngoài sandbox), bind vào sandbox ở SB_SOCK
SB_SOCK = "/run/ginger-api.sock"
SB_PORT = 8787  # trong sandbox: 127.0.0.1:SB_PORT → SB_SOCK
API_UPSTREAM = "https://api.anthropic.com"
API_PATHS = ("/v1/messages",)
DUMMY_TOKEN = "token-gia-trong-sandbox"  # proxy thay bằng token thật
# Proxy CONNECT cho việc cài gói: chỉ tới các kho gói này (cổng 443). npm, uv đọc HTTPS_PROXY.
REG_SOCK = DATA / "reg.sock"
SB_REG_SOCK = "/run/ginger-reg.sock"
SB_REG_PORT = 8788
# reactnative.directory: npx expo install tra thông tin gói ở đây.
REGISTRY_HOSTS = {"registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "api.expo.dev", "reactnative.directory"}
OVL_ROOT = DATA / "ovl"  # lớp ghi chồng lên venv / node_modules thật, mỗi việc một bộ
UV = HOME / ".local/bin/uv"
# Chạy trong sandbox (python3 hệ thống): chuyển từng cổng TCP 127.0.0.1 sang unix socket tương ứng
# (đối số: socket cổng socket cổng ...).
FORWARDER = """import asyncio, sys
async def pipe(r, w):
    try:
        while (d := await r.read(65536)):
            w.write(d)
            await w.drain()
    finally:
        w.close()
def handler(path):
    async def conn(r, w):
        ur, uw = await asyncio.open_unix_connection(path)
        await asyncio.gather(pipe(r, uw), pipe(ur, w), return_exceptions=True)
    return conn
async def main():
    a = sys.argv[1:]
    servers = [await asyncio.start_server(handler(a[i]), "127.0.0.1", int(a[i + 1])) for i in range(0, len(a), 2)]
    await asyncio.gather(*(s.serve_forever() for s in servers))
asyncio.run(main())
"""

RUN_TIMEOUT_SEC = 1200
MAX_TURNS = 80
POLL_SEC = 1.0
HEALTH_WAIT_SEC = 45
HEALTH_MIN_SEC = 12  # dịch vụ phải chạy liền chừng này mới coi là lên được
OTA_TIMEOUT_SEC = 900
# Kết quả việc sửa code chờ được đọc lâu hơn trình duyệt: anh thường đã tắt app trong lúc chờ.
ANNOUNCE_WINDOW = "2 hours"
SERVICES = ["ginger-backend", "ginger-agent", "ginger-browser"]

SYSTEM = """Bạn đang sửa mã nguồn của Ginger, tức chính trợ lý Gừng, theo yêu cầu người dùng nói bằng giọng
qua Gừng. Yêu cầu đi qua nhận dạng giọng nói nên có thể sai chữ: đoán theo ngữ cảnh code.

Môi trường:
- Bản clone riêng, nhánh riêng. Không có file .env, không thấy repo gốc, không khởi động lại dịch vụ hay
  push được (việc đó Gừng làm sau khi người dùng đồng ý). Không có mạng (không tới được DB hay backend thật);
  chỉ tìm web được bằng WebSearch và tải gói từ npm / PyPI.
- Cài thư viện: Python `uv pip install --python backend/.venv/bin/python <gói>` rồi ghi vào
  backend/requirements.txt; app: `npx expo install <gói>` trong app/. venv và node_modules ở đây là bản riêng,
  cài thoải mái; lúc áp dụng Gừng tự cài vào bản thật. Thư viện native của app (có mã iOS) thì phải build lại
  app trên Mac, không đẩy qua mạng được: chỉ thêm khi thật cần và nói rõ trong tóm tắt.
- Kiểm tra: backend/.venv/bin/python -m py_compile <file>; trong app/: npx tsc --noEmit và npx expo lint.
- Không ai trả lời giữa chừng nên đừng hỏi lại: thiếu thông tin thì chọn cách hợp lý nhất, nói rõ trong tóm tắt.
- Yêu cầu chỉ là câu hỏi về code (không cần sửa) thì trả lời, không sửa gì.
- Repo public: không đưa tên máy, email, địa chỉ, khoá hay token vào code.
- Xong thì commit trên nhánh hiện tại (git add -A rồi git commit, message tiếng Việt ngắn). Cập nhật
  CLAUDE.md nếu thay đổi đáng ghi lại.

Câu trả lời cuối cùng của bạn được đọc to cho người dùng, bạn nói thay Gừng (bỏ qua cách xưng "em" trong
CLAUDE.md): Gừng tự xưng "Gừng", gọi người dùng là "{address}". Văn nói tiếng Việt, 1–3 câu, không
markdown, không đường dẫn file hay tên hàm; nói đã đổi gì (người dùng sẽ thấy khác gì) và đã kiểm tra chưa.
Không hỏi có áp dụng không (Gừng tự hỏi sau)."""

# Tool Gừng (llm.stream_reply) dùng để giao việc. Cố định để không lệch prompt cache.
DEV_TOOL = {
    "name": "dev_task",
    "description": (
        "Sửa mã nguồn của chính Gừng (app Ginger: backend, agent giọng nói, app điện thoại) theo yêu cầu "
        "người dùng. Dùng khi người dùng nhờ sửa lỗi, thêm tính năng hay đổi cách Gừng hoạt động bằng code, "
        "hoặc hỏi về code của Gừng. Chạy nền vài phút trên bản sao riêng; xong tự báo tóm tắt và hỏi người "
        "dùng có áp dụng không. Trước khi giao việc chỉ nói một câu ngắn kiểu \"Dạ, Gừng sửa đây, xong Gừng "
        "báo nhé.\" rồi gọi tool, không nói thêm. "
        "action new: việc mới, instruction ghi đầy đủ đúng ý người dùng (sửa chỗ nghe nhầm rõ ràng). "
        "Khi Gừng đang hỏi người dùng (áp dụng, đẩy bản cập nhật app, push lên GitHub): đồng ý → approve; "
        "muốn sửa thêm hay sửa khác → revise kèm lời dặn trong instruction; bảo thôi → cancel."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["new", "approve", "revise", "cancel"]},
            "instruction": {"type": "string", "description": "new / revise: yêu cầu. approve / cancel: bỏ trống."},
        },
        "required": ["action"],
    },
}

ACTIVE = ("queued", "running", "approved", "waiting")


class Cancelled(Exception):
    pass


def allowed(user_id: UUID | None) -> bool:
    return user_id is not None and str(user_id) in settings.dev_user_ids


# ---------- Phía Gừng (backend /chat và agent giọng nói) ----------

async def handle_tool(user_id: UUID, conversation_id: UUID, args: dict) -> tuple[bool, str]:
    """Chạy tool dev_task. Trả (làm được không, lời ngắn cho Claude — không đọc to)."""
    if not allowed(user_id):
        return False, "Tài khoản này không được sửa mã nguồn."
    action = args.get("action")
    text = (args.get("instruction") or "").strip()
    async with pool.connection() as conn:
        active = await (await conn.execute(
            "SELECT id, status, stage, instruction FROM dev_tasks WHERE user_id = %s AND status = ANY(%s) "
            "ORDER BY created_at DESC LIMIT 1", (user_id, list(ACTIVE)),
        )).fetchone()
        waiting = active is not None and active["status"] == "waiting"
        if action == "cancel":
            if not active:
                return False, "Không có việc sửa code nào đang làm."
            await conn.execute(
                "UPDATE dev_tasks SET status = 'cancelled', finished_at = now(), announced = true WHERE id = %s",
                (active["id"],),
            )
            log.info("Huỷ việc %s", active["id"])
            return True, "Đã huỷ."
        if action == "approve":
            if not waiting:
                return False, "Không có việc sửa code nào đang chờ người dùng đồng ý."
            await conn.execute("UPDATE dev_tasks SET status = 'approved', announced = false WHERE id = %s",
                               (active["id"],))
            log.info("Người dùng đồng ý việc %s (bước %s)", active["id"], active["stage"])
            return True, "Đã chuyển, Gừng đang làm. Kết quả sẽ tự báo."
        if not text:
            return False, "Thiếu instruction."
        if action == "revise":
            if not waiting or active["stage"] != "review":
                return False, "Không có bản sửa nào đang chờ duyệt. Muốn sửa thêm thì giao việc mới (action new)."
            await conn.execute(
                "UPDATE dev_tasks SET status = 'queued', pending_input = %s, announced = false WHERE id = %s",
                (text, active["id"]),
            )
            log.info("Sửa thêm việc %s: %r", active["id"], text)
            return True, "Đã chuyển lời dặn, Gừng đang sửa tiếp. Kết quả sẽ tự báo."
        if active and not waiting:
            return False, (f"Đang sửa dở việc khác: {active['instruction']!r}. Nói người dùng chờ xong, "
                           "hoặc huỷ việc đó (action cancel) rồi giao lại.")
        if waiting:  # việc mới thay cho việc đang chờ (bỏ các bước còn lại của việc cũ)
            await conn.execute(
                "UPDATE dev_tasks SET status = 'cancelled', finished_at = now(), announced = true WHERE id = %s",
                (active["id"],),
            )
        row = await (await conn.execute(
            "INSERT INTO dev_tasks (user_id, conversation_id, instruction) VALUES (%s, %s, %s) RETURNING id",
            (user_id, conversation_id, text),
        )).fetchone()
    log.info("Giao việc %s: %r", row["id"], text)
    return True, "Đã giao việc, Gừng đang sửa code. Kết quả sẽ tự báo cho người dùng, bạn không cần chờ."


async def status_for_prompt(user_id: UUID) -> str:
    if not allowed(user_id):
        return ""
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "SELECT status, stage, instruction, progress, result, created_at FROM dev_tasks "
            "WHERE user_id = %s AND status = ANY(%s) ORDER BY created_at DESC LIMIT 1", (user_id, list(ACTIVE)),
        )).fetchone()
    if not row:
        return ""
    what = f"việc sửa code «{row['instruction']}»"
    if row["status"] == "waiting":
        return f"Gừng đang chờ người dùng trả lời cho {what}: {row['result']}"
    if row["status"] == "approved":
        step = {"review": "gộp và khởi động lại", "ota": "đẩy bản cập nhật app", "push": "push lên GitHub"}
        return f"Gừng đang {step[row['stage']]} cho {what}."
    secs = int((datetime.now(TZ) - row["created_at"]).total_seconds())
    out = f"Gừng đang làm {what} (đã {secs // 60} phút)"
    return out + (f", bước gần nhất: {row['progress']}." if row["progress"] else ".")


async def pending_announcements(user_id: UUID) -> list[dict]:
    if not allowed(user_id):
        return []
    async with pool.connection() as conn:
        return await (await conn.execute(
            "SELECT id, result FROM dev_tasks WHERE user_id = %s AND NOT announced "
            "AND status IN ('done', 'waiting', 'failed') AND result IS NOT NULL "
            f"AND finished_at > now() - interval '{ANNOUNCE_WINDOW}' ORDER BY finished_at", (user_id,),
        )).fetchall()


async def mark_announced(task_id: UUID) -> None:
    async with pool.connection() as conn:
        await conn.execute("UPDATE dev_tasks SET announced = true WHERE id = %s", (task_id,))


# ---------- Chạy lệnh ----------

async def _run(args: list[str], cwd: Path | None = None, env: dict | None = None,
               timeout: float = 120) -> tuple[int, str]:
    """Lệnh tin cậy ngoài sandbox. Trả (mã thoát, stdout+stderr)."""
    p = await asyncio.create_subprocess_exec(*args, cwd=cwd, env=env, stdout=PIPE, stderr=STDOUT)
    try:
        async with asyncio.timeout(timeout):
            out, _ = await p.communicate()
    except TimeoutError:
        p.kill()
        await p.wait()
        return -1, f"Quá {timeout:.0f}s: {' '.join(args[:3])}"
    return p.returncode, out.decode(errors="replace")


async def _git(*args: str, timeout: float = 60) -> tuple[int, str]:
    return await _run(["git", "-C", str(REPO), *args], timeout=timeout)


def _node_bin() -> str:
    found = sorted((HOME / ".local/share/fnm/node-versions").glob("*/installation/bin"))
    if found:
        return str(found[-1])
    node = shutil.which("node")
    return str(Path(node).resolve().parent) if node else "/usr/bin"


def _claude_bin() -> str:
    return str((HOME / ".local/bin/claude").resolve())


def _sandbox(binds: list[str], chdir: Path, api: bool = False, reg: bool = False) -> list[str]:
    """Hộp cát: hệ thống chỉ đọc, không mạng, HOME riêng; giấu nhà anh, /mnt (ổ Windows, chạy được .exe),
    /run (systemd, Docker socket). api / reg: cho tới proxy Anthropic / proxy kho gói."""
    a = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
         "--tmpfs", "/run", "--tmpfs", "/mnt", "--tmpfs", str(HOME)]
    if api:
        a += ["--bind", str(API_SOCK), SB_SOCK]
    if reg:
        a += ["--bind", str(REG_SOCK), SB_REG_SOCK]
    for d in (HOME / ".local/share/claude", HOME / ".local/share/fnm", UV):
        if d.exists():
            a += ["--ro-bind", str(d), str(d)]
    a += ["--bind", str(SB_HOME), str(SB_HOME), *binds]
    return a + ["--unshare-net", "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session",
                "--chdir", str(chdir), "--"]


def _bwrap(wt: Path, io: Path, api: bool = False, reg: bool = False) -> list[str]:
    """Sandbox của một việc: bản clone + thư mục io; venv / node_modules là lớp ghi chồng lên bản thật
    (cài gói thoải mái, bản thật không đổi)."""
    binds = []
    for d in (wt, io):
        binds += ["--bind", str(d), str(d)]
    for name, src, dst in (("venv", REPO / "backend/.venv", wt / "backend/.venv"),
                           ("nm", REPO / "app/node_modules", wt / "app/node_modules")):
        if src.exists():
            up, work = OVL_ROOT / wt.name / name / "up", OVL_ROOT / wt.name / name / "work"
            up.mkdir(parents=True, exist_ok=True)
            work.mkdir(parents=True, exist_ok=True)
            binds += ["--overlay-src", str(src), "--overlay", str(up), str(work), str(dst)]
    return _sandbox(binds, wt, api=api, reg=reg)


def _with_net(cmd: list[str], api: bool, reg: bool) -> list[str]:
    """Bật bộ chuyển cổng tới proxy trong sandbox rồi mới chạy lệnh."""
    pairs = ([SB_SOCK, str(SB_PORT)] if api else []) + ([SB_REG_SOCK, str(SB_REG_PORT)] if reg else [])
    ports = " ".join(pairs[1::2])
    boot = (f'python3 -c "$FORWARDER" {" ".join(pairs)} & '
            f'for p in {ports}; do for i in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && break; '
            'sleep 0.1; done; done; exec "$@"')
    return ["bash", "-c", boot, "_", *cmd]


async def _identity() -> dict:
    out = {}
    for key, names in (("user.name", ("GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME")),
                       ("user.email", ("GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"))):
        _, v = await _git("config", key)
        for n in names:
            out[n] = v.strip()
    return out


async def _sb_env(api: bool = False, reg: bool = False) -> dict:
    env = {"PATH": f"{_node_bin()}:{UV.parent}:/usr/local/bin:/usr/bin:/bin", "HOME": str(SB_HOME),
           "LANG": "C.UTF-8", "TERM": "dumb", "DISABLE_AUTOUPDATER": "1", "EXPO_NO_TELEMETRY": "1",
           "NPM_CONFIG_UPDATE_NOTIFIER": "false", "NPM_CONFIG_AUDIT": "false", "NPM_CONFIG_FUND": "false",
           "UV_LINK_MODE": "copy", "UV_PYTHON_DOWNLOADS": "never", "FORWARDER": FORWARDER, **await _identity()}
    if not reg:
        env["NPM_CONFIG_OFFLINE"] = "true"
    else:
        proxy = f"http://127.0.0.1:{SB_REG_PORT}"
        env |= {"HTTPS_PROXY": proxy, "HTTP_PROXY": proxy, "https_proxy": proxy, "http_proxy": proxy,
                "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
    if api:  # token giả: proxy thay bằng token thật
        env |= {"CLAUDE_CODE_OAUTH_TOKEN": DUMMY_TOKEN, "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{SB_PORT}",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}
    return env


async def _sb(wt: Path, io: Path, script: str, timeout: float = 300) -> tuple[int, str]:
    """Chạy một đoạn bash trong sandbox (thao tác git trên bản clone)."""
    return await _run([*_bwrap(wt, io), "bash", "-c", script], env=await _sb_env(), timeout=timeout)


def _tail(text: str, n: int = 40) -> str:
    return "\n".join(text.strip().splitlines()[-n:])


# ---------- Proxy gắn token ----------

_HOP = {"host", "authorization", "x-api-key", "content-length", "transfer-encoding", "connection", "accept-encoding"}


async def _proxy(req: web.Request) -> web.StreamResponse:
    path = req.rel_url.path
    if req.method != "POST" or not path.startswith(API_PATHS):
        log.warning("Proxy chặn %s %s", req.method, path)
        return web.Response(status=403, text="Không được phép")
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
    headers = {k: v for k, v in req.headers.items() if k.lower() not in _HOP} | {"authorization": f"Bearer {token}"}
    body = await req.read()
    async with req.app["http"].post(API_UPSTREAM + str(req.rel_url), headers=headers, data=body) as up:
        resp = web.StreamResponse(status=up.status, headers={
            k: v for k, v in up.headers.items()
            if k.lower() not in ("content-length", "transfer-encoding", "content-encoding", "connection")})
        await resp.prepare(req)
        async for chunk in up.content.iter_any():
            await resp.write(chunk)
        await resp.write_eof()
        return resp


async def _pipe(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
    try:
        while data := await r.read(65536):
            w.write(data)
            await w.drain()
    finally:
        w.close()


async def _registry_conn(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
    """Proxy CONNECT: chỉ mở đường hầm TLS tới REGISTRY_HOSTS:443."""
    try:
        head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 10)
        parts = head.split(b"\r\n", 1)[0].decode(errors="replace").split()
        host, _, port = parts[1].rpartition(":") if len(parts) > 1 else ("", "", "")
        if parts[0] != "CONNECT" or host not in REGISTRY_HOSTS or port != "443":
            log.warning("Proxy kho gói chặn %s", " ".join(parts[:2])[:200])
            w.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            await w.drain()
            w.close()
            return
        ur, uw = await asyncio.wait_for(asyncio.open_connection(host, 443), 15)
        w.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await w.drain()
        await asyncio.gather(_pipe(r, uw), _pipe(ur, w), return_exceptions=True)
    except Exception as e:
        log.info("Proxy kho gói: %s", e)
        w.close()


async def _start_proxy() -> None:
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.router.add_route("*", "/{path:.*}", _proxy)

    async def http(app: web.Application):
        app["http"] = ClientSession(timeout=ClientTimeout(total=None, sock_read=600))
        yield
        await app["http"].close()

    app.cleanup_ctx.append(http)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    API_SOCK.unlink(missing_ok=True)
    await web.UnixSite(runner, str(API_SOCK)).start()
    API_SOCK.chmod(0o600)
    REG_SOCK.unlink(missing_ok=True)
    _start_proxy.reg = await asyncio.start_unix_server(_registry_conn, str(REG_SOCK))
    REG_SOCK.chmod(0o600)


# ---------- Worker ----------

async def _set(task_id: UUID, **cols) -> None:
    sets = ", ".join(f"{k} = %s" for k in cols)
    async with pool.connection() as conn:
        await conn.execute(f"UPDATE dev_tasks SET {sets} WHERE id = %s", (*cols.values(), task_id))


async def _status(task_id: UUID) -> str:
    async with pool.connection() as conn:
        row = await (await conn.execute("SELECT status FROM dev_tasks WHERE id = %s", (task_id,))).fetchone()
    return row["status"] if row else "cancelled"


async def _say(task: dict, status: str, message: str, **cols) -> None:
    """Kết thúc một bước: ghi lời Gừng vào cuộc trò chuyện, agent giọng nói sẽ đọc lên."""
    if task.get("conversation_id"):
        await memory.add_message(task["conversation_id"], "assistant", message)
    await _set(task["id"], status=status, result=message, finished_at=datetime.now(TZ), progress=None,
               announced=False, **cols)
    log.info("Việc %s %s: %s", task["id"], status, message)


def _brief(block: dict) -> str:
    """Bước Claude Code đang làm, để Gừng trả lời được "tới đâu rồi"."""
    name, inp = block.get("name", ""), block.get("input") or {}
    if "file_path" in inp:
        return f"{name} {Path(inp['file_path']).name}"
    if name == "Bash":
        return f"chạy lệnh {inp.get('description') or str(inp.get('command', ''))[:80]}"
    return name


async def _claude(task: dict, wt: Path, io: Path, prompt: str, session_id: str | None,
                  address: str) -> tuple[bool, str, str | None]:
    """Chạy `claude -p` trong sandbox. Trả (thành công, câu trả lời cuối, session_id)."""
    cmd = [_claude_bin(), "-p", prompt, "--output-format", "stream-json", "--verbose",
           "--model", settings.dev_model, "--dangerously-skip-permissions", "--disallowedTools", "WebFetch", "--max-turns", str(MAX_TURNS),
           "--append-system-prompt", SYSTEM.format(address=address)]
    if session_id:
        cmd += ["--resume", session_id]
    proc = await asyncio.create_subprocess_exec(
        *_bwrap(wt, io, api=True, reg=True), *_with_net(cmd, api=True, reg=True), env=await _sb_env(api=True, reg=True),
        stdout=PIPE, stderr=PIPE, limit=64 * 1024 * 1024, start_new_session=True,
    )
    result: dict = {}
    cancelled = False

    async def watch_cancel() -> None:
        nonlocal cancelled
        while True:
            await asyncio.sleep(3)
            if await _status(task["id"]) == "cancelled":
                cancelled = True
                with suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGTERM)
                return

    watcher = asyncio.create_task(watch_cancel())
    t0 = time.monotonic()
    try:
        async with asyncio.timeout(RUN_TIMEOUT_SEC):
            async for line in proc.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("type") == "system" and ev.get("session_id") and not session_id:
                    session_id = ev["session_id"]
                    await _set(task["id"], session_id=session_id)
                elif ev.get("type") == "assistant":
                    for b in ev.get("message", {}).get("content", []):
                        if b.get("type") == "tool_use":
                            brief = _brief(b)
                            log.info("Việc %s: %s", task["id"], brief)
                            await _set(task["id"], progress=brief)
                elif ev.get("type") == "result":
                    result = ev
            await proc.wait()
    except TimeoutError:
        with suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
        await proc.wait()
        return False, "Việc này lâu quá nên Gừng dừng lại rồi.", session_id
    finally:
        watcher.cancel()
    if cancelled:
        raise Cancelled
    err = (await proc.stderr.read()).decode(errors="replace")
    log.info("Việc %s: Claude Code %.0fs, %s lượt, giá ước tính theo API %s USD, mã thoát %s",
             task["id"], time.monotonic() - t0, result.get("num_turns"), result.get("total_cost_usd"), proc.returncode)
    text = (result.get("result") or "").strip()
    if result.get("is_error") or not text:
        log.warning("Việc %s lỗi Claude Code: %s | %s", task["id"], text[:500], _tail(err, 10))
        return False, "Phần sửa code của Gừng bị lỗi, có thể đã hết lượt dùng của gói, nên chưa làm xong.", session_id
    return True, text, result.get("session_id") or session_id


async def _changed_files(wt: Path, io: Path, base: str, msg: str) -> tuple[int, list[str]]:
    script = ('set -e; git add -A; git diff --cached --quiet || git commit -qm "$1"; '
              f'git diff --name-only {base}..HEAD')
    rc, out = await _run([*_bwrap(wt, io), "bash", "-c", script, "_", msg], env=await _sb_env())
    return rc, [f for f in out.splitlines() if f.strip()] if rc == 0 else []


async def run_claude(task: dict, revise: str | None) -> None:
    tid = task["id"]
    short = str(tid)[:8]
    wt, io = WT_ROOT / short, IO_ROOT / short
    io.mkdir(parents=True, exist_ok=True)
    address = await _address(task["user_id"])
    base = task["base_commit"]
    if not task["session_id"]:
        shutil.rmtree(wt, ignore_errors=True)
        rc, out = await _run(["git", "clone", "-q", "--no-hardlinks", str(REPO), str(wt)])
        if rc:
            raise RuntimeError(out)
        # Bản clone vừa tạo, Claude chưa đụng vào: chạy git ngoài sandbox ở đây còn an toàn.
        await _run(["git", "-C", str(wt), "checkout", "-q", "-b", f"gung/{short}"])
        await _run(["git", "-C", str(wt), "remote", "remove", "origin"])
        base = (await _run(["git", "-C", str(wt), "rev-parse", "HEAD"]))[1].strip()
        await _set(tid, base_commit=base)
        now = datetime.now(TZ).strftime("%H:%M %d/%m/%Y")
        prompt = f"Bây giờ là {now}.\n\nYêu cầu của người dùng: {task['instruction']}"
    else:
        prompt = f"Người dùng dặn thêm: {revise}"
        if task["last_error"]:
            prompt += f"\n\nLần áp dụng trước bị lỗi, Gừng đã quay về bản cũ. Log:\n{task['last_error']}"
            await _set(tid, last_error=None)
    session_id = task["session_id"]
    for attempt in range(2):
        ok, text, session_id = await _claude(task, wt, io, prompt, session_id, address)
        if not ok:
            await _say(task, "failed", text)
            return
        rc, files = await _changed_files(wt, io, base, f"Gừng: {task['instruction'][:70]}")
        py = [f for f in files if f.endswith(".py") and (wt / f).exists()]
        if not py:
            break
        rc, out = await _sb(wt, io, "backend/.venv/bin/python -m py_compile " + " ".join(f"'{f}'" for f in py))
        if rc == 0:
            break
        log.info("Việc %s: lỗi cú pháp, cho Claude sửa lại", tid)
        prompt = f"Kiểm tra cú pháp bị lỗi, sửa cho hết rồi commit:\n{_tail(out)}"
    else:
        await _say(task, "failed", "Gừng sửa mãi code vẫn còn lỗi cú pháp nên dừng lại, chưa áp dụng gì.")
        return
    if not files:
        await _say(task, "done", text)
        return
    q = f"Áp dụng luôn nhé {address}?"
    if any(f.startswith("backend/app/") for f in files):
        q = f"Lúc áp dụng Gừng phải khởi động lại nên cuộc gọi sẽ ngắt một lát. {q}"
    await _say(task, "waiting", f"{text} {q}", stage="review", files=files)


async def _install_main(files: list[str], io: Path) -> str | None:
    """Cài gói mới vào venv / node_modules thật. Chạy trong sandbox (chỉ thấy đúng thư mục cần ghi, mạng chỉ tới
    kho gói), vì cài gói là chạy script của gói (setup.py, postinstall). Trả log nếu lỗi."""
    jobs = []
    if "backend/requirements.txt" in files:
        d = io / "py"
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / "backend/requirements.txt", d)
        venv = REPO / "backend/.venv"
        jobs.append((["--bind", str(venv), str(venv), "--bind", str(d), str(d)], d,
                     [str(UV), "pip", "install", "-q", "--python", str(venv / "bin/python"), "-r", "requirements.txt"]))
    if {"app/package.json", "app/package-lock.json"} & set(files):
        d = io / "npm"
        d.mkdir(parents=True, exist_ok=True)
        for f in ("package.json", "package-lock.json"):
            shutil.copy(REPO / "app" / f, d)
        nm = REPO / "app/node_modules"
        jobs.append((["--bind", str(d), str(d), "--bind", str(nm), str(d / "node_modules")], d,
                     ["npm", "install", "--loglevel=error"]))
    for binds, cwd, cmd in jobs:
        rc, out = await _run([*_sandbox(binds, cwd, reg=True), *_with_net(cmd, api=False, reg=True)],
                             env=await _sb_env(reg=True), timeout=900)
        log.info("Cài gói vào bản thật (%s): mã thoát %s", cmd[0], rc)
        if rc:
            return out
    return None


async def _health(since: float, restarted: list[str]) -> str | None:
    """Chờ các dịch vụ lên lại. Trả None nếu ổn, không thì tên dịch vụ lỗi + log.

    Dịch vụ chết lúc khởi động vẫn "active" vài giây đầu (Type=simple) rồi systemd tự chạy lại (PID mới), nên
    chỉ coi là ổn khi đã qua HEALTH_MIN_SEC mà mọi dịch vụ vẫn active với cùng PID như lần xem trước."""
    t0 = time.monotonic()
    stamp = datetime.fromtimestamp(since).strftime("%Y-%m-%d %H:%M:%S")
    bad, prev = restarted[0], {}
    while time.monotonic() - t0 < HEALTH_WAIT_SEC:
        await asyncio.sleep(3)
        bad, pids = None, {}
        for svc in restarted:
            _, out = await _run(["systemctl", "--user", "show", "-p", "ActiveState", "-p", "MainPID", "--value", svc])
            state, pid = (out.split() + ["", ""])[:2]
            pids[svc] = pid
            if state != "active" or pid in ("", "0") or prev.get(svc, pid) != pid:
                bad = svc
                break
        prev = pids
        if bad is None and "ginger-backend" in restarted:
            try:
                async with httpx.AsyncClient(timeout=3) as c:
                    if (await c.get("http://127.0.0.1:8000/health")).status_code != 200:
                        bad = "ginger-backend"
            except httpx.HTTPError:
                bad = "ginger-backend"
        if bad is None and "ginger-agent" in restarted:
            _, log_out = await _run(["journalctl", "--user", "-u", "ginger-agent", "--since", stamp, "-o", "cat"])
            if "registered worker" not in log_out:
                bad = "ginger-agent"
        if bad is None and time.monotonic() - t0 >= HEALTH_MIN_SEC:
            return None
    _, log_out = await _run(["journalctl", "--user", "-u", bad, "--since", stamp, "-o", "cat", "--no-pager"])
    return f"{bad}:\n{_tail(log_out)}"


async def _apply(task: dict, address: str) -> None:
    tid, short = task["id"], str(task["id"])[:8]
    wt, io = WT_ROOT / short, IO_ROOT / short
    io.mkdir(parents=True, exist_ok=True)
    await asyncio.sleep(4)  # để Gừng nói xong câu "Dạ" trước khi agent bị khởi động lại
    rc, branch = await _git("symbolic-ref", "--short", "HEAD")
    if branch.strip() != "main":
        await _say(task, "waiting", f"Repo đang không ở nhánh main nên Gừng chưa gộp được. {address.capitalize()} "
                   "chuyển về main rồi bảo Gừng áp dụng lại nhé.")
        return
    for f in io.glob("*.bundle"):
        f.unlink()
    rc, out = await _git("bundle", "create", "-q", str(io / "main.bundle"), "main")
    if rc:
        raise RuntimeError(out)
    # Đưa nhánh của Gừng lên main mới nhất (trong sandbox), xuất ra bundle.
    rc, out = await _sb(wt, io, (
        f"set -e; git fetch -q {io}/main.bundle +main:refs/remotes/up/main; "
        "git rebase -q up/main >/dev/null 2>&1 || { git rebase --abort; git rev-parse up/main; exit 3; }; "
        f"git branch -f gung-out HEAD; git bundle create -q {io}/out.bundle up/main..gung-out; git rev-parse up/main"))
    if rc == 3:
        await _set(tid, base_commit=out.split()[-1], last_error=(
            "Rebase lên up/main (main mới nhất) bị xung đột. Hãy rebase lên up/main, giải quyết xung đột rồi commit."))
        await _say(task, "waiting", "Trên main vừa có thay đổi đụng vào cùng chỗ Gừng sửa nên chưa gộp được. "
                   f"Gừng sửa lại cho khớp nhé {address}?")
        return
    if rc:
        raise RuntimeError(out)
    await _set(tid, base_commit=out.split()[-1])
    rc, out = await _git("fetch", "-q", str(io / "out.bundle"), f"+gung-out:refs/gung/{short}")
    if rc:
        raise RuntimeError(out)
    old = (await _git("rev-parse", "HEAD"))[1].strip()
    rc, out = await _git("merge", "--ff-only", "-q", f"refs/gung/{short}")
    if rc:
        log.warning("Việc %s: gộp không được: %s", tid, out)
        await _say(task, "waiting", f"Gừng chưa gộp được vì trong repo đang có chỗ sửa dở trùng file. "
                   f"{address.capitalize()} cất phần đó đi rồi bảo Gừng áp dụng lại nhé.")
        return
    new = (await _git("rev-parse", "HEAD"))[1].strip()
    files = [f for f in (await _git("diff", "--name-only", old, new))[1].splitlines() if f]
    await _set(tid, applied_from=old, applied_to=new)
    log.info("Việc %s: đã gộp %s..%s (%d file)", tid, old[:7], new[:7], len(files))

    async def rollback(reason: str, restart: list[str]) -> None:
        log.warning("Việc %s: quay về %s: %s", tid, old[:7], reason)
        await _git("reset", "--keep", old)
        if restart:
            await _run(["systemctl", "--user", "restart", *restart])
        await _set(tid, last_error=reason, applied_to=None)

    backend = [f for f in files if f.startswith("backend/")]
    py_changed = any(f.startswith("backend/app/") and f.endswith(".py") for f in files)
    if err := await _install_main(files, io):
        await rollback(f"Cài thư viện lỗi:\n{_tail(err)}", [])
        await _say(task, "waiting", "Cài thư viện mới bị lỗi nên Gừng đã quay về bản cũ. "
                   f"Gừng tìm cách sửa tiếp nhé {address}?", stage="review")
        return
    if py_changed:
        rc, out = await _run([str(REPO / "backend/.venv/bin/python"), "-c",
                              "import app.main, app.agent, app.browser, app.dev"], cwd=REPO / "backend")
        if rc:
            await rollback(f"Import lỗi:\n{_tail(out)}", [])
            await _say(task, "waiting", "Code mới chạy thử bị lỗi nên Gừng chưa áp dụng, vẫn giữ bản cũ. "
                       f"Gừng tìm lỗi sửa tiếp nhé {address}?", stage="review")
            return
    restarted = SERVICES if backend else []
    if restarted:
        since = time.time()
        await _run(["systemctl", "--user", "restart", *restarted])
        bad = await _health(since, restarted)
        if bad:
            await rollback(bad, restarted)
            name = {"ginger-backend": "máy chủ", "ginger-agent": "giọng nói", "ginger-browser": "trình duyệt"}.get(
                bad.split(":")[0], bad.split(":")[0])
            await _say(task, "waiting", f"Áp dụng xong thì phần {name} không chạy được nên Gừng đã quay về bản cũ. "
                       f"Gừng tìm lỗi sửa tiếp nhé {address}?", stage="review")
            return
    done = "Gừng đã áp dụng xong, mọi thứ chạy bình thường." if restarted else "Gừng đã gộp xong."
    if any(f.startswith("app/") for f in files):
        await _say(task, "waiting", f"{done} Phần app cần đẩy bản cập nhật, Gừng đẩy luôn nhé?", stage="ota")
    else:
        await _say(task, "waiting", f"{done} Gừng push lên GitHub luôn nhé?", stage="push")
    if py_changed:  # chính worker này cũng chạy code backend/app: nạp bản mới (trạng thái đã lưu ở trên)
        await _run(["systemctl", "--user", "restart", "--no-block", "ginger-dev"])


def _expo_token() -> str:
    with suppress(OSError):
        for line in (HOME / ".zshrc").read_text().splitlines():
            if line.startswith("export EXPO_TOKEN="):
                return line.split("=", 1)[1].strip().strip("'\"")
    return ""


async def _ota(task: dict, address: str) -> None:
    env = {**os.environ, "EXPO_TOKEN": _expo_token(),
           "PATH": f"{_node_bin()}:{HOME / '.local/bin'}:/usr/local/bin:/usr/bin:/bin"}
    rc, out = await _run(["bash", "scripts/ota.sh", f"Gừng: {task['instruction'][:80]}"], cwd=REPO / "app",
                         env=env, timeout=OTA_TIMEOUT_SEC)
    if rc == 0:
        msg = "Gừng đã đẩy bản cập nhật app, mở lại app hai lần là có."
    elif "phải build lại" in out:
        msg = "Thay đổi này đụng phần native của app nên phải build lại, Gừng không đẩy qua mạng được."
    else:
        log.warning("Việc %s: OTA lỗi:\n%s", task["id"], _tail(out))
        msg = "Đẩy bản cập nhật app bị lỗi, chi tiết Gừng ghi trong log."
    await _say(task, "waiting", f"{msg} Gừng push lên GitHub luôn nhé?", stage="push")


def _secrets() -> list[str]:
    vals = []
    for f in (REPO / "backend/.env", REPO / "app/.env"):
        with suppress(OSError):
            for line in f.read_text().splitlines():
                if "=" in line and not line.lstrip().startswith("#"):
                    v = line.split("=", 1)[1].strip().strip("'\"")
                    if len(v) >= 8:
                        vals.append(v)
    return vals


async def _push(task: dict, address: str) -> None:
    if not PUSH_DENY_FILE.exists():
        await _say(task, "failed", "Gừng chưa có danh sách thông tin riêng tư cần chặn nên không dám push.")
        return
    rc, out = await _git("fetch", "-q", "origin", timeout=60)
    if rc:
        raise RuntimeError(out)
    commits = (await _git("rev-list", "--count", "origin/main..main"))[1].strip()
    if commits == "0":
        await _say(task, "done", "Trên GitHub đã có đủ rồi, không cần push nữa.")
        return
    # Chỉ quét nội dung + message, không quét tên/email tác giả (email GitHub noreply là bình thường).
    _, diff = await _git("log", "-p", "--format=%B", "origin/main..main")
    patterns = [p.strip() for p in PUSH_DENY_FILE.read_text().splitlines() if p.strip() and not p.startswith("#")]
    hit = next((i for i, p in enumerate(patterns) if re.search(p, diff, re.I)), None)
    secret = next((i for i, v in enumerate(_secrets()) if v in diff), None)
    home = str(HOME) in diff
    if hit is not None or secret is not None or home:
        log.warning("Việc %s: chặn push (mẫu %s, secret %s, đường dẫn nhà %s)", task["id"], hit, secret, home)
        await _say(task, "failed", "Gừng thấy trong thay đổi có thông tin riêng tư nên không push. "
                   f"{address.capitalize()} xem lại giúp Gừng nhé.")
        return
    rc, out = await _git("push", "-q", "origin", "main", timeout=120)
    if rc:
        log.warning("Việc %s: push lỗi:\n%s", task["id"], _tail(out))
        await _say(task, "failed", "Push lên GitHub bị lỗi, có thể trên GitHub có thay đổi mới. Chi tiết Gừng ghi trong log.")
        return
    n = f"{commits} commit" if commits != "1" else "một commit"
    await _say(task, "done", f"Gừng đã push {n} lên GitHub rồi {address}.")


async def run_stage(task: dict) -> None:
    address = await _address(task["user_id"])
    stage = task["stage"]
    log.info("Việc %s: làm bước %s", task["id"], stage)
    await {"review": _apply, "ota": _ota, "push": _push}[stage](task, address)


async def _cleanup() -> None:
    """Xoá bản clone của việc đã xong (giữ việc còn chờ duyệt để sửa tiếp được)."""
    async with pool.connection() as conn:
        keep = {str(r["id"])[:8] for r in await (await conn.execute(
            "SELECT id FROM dev_tasks WHERE status = ANY(%s) AND stage = 'review'", (list(ACTIVE),),
        )).fetchall()}
    for root in (WT_ROOT, IO_ROOT, OVL_ROOT):
        for d in root.iterdir():
            if d.name in keep:
                continue
            # Thư mục work của overlay có quyền 000: mở quyền trước khi xoá (os.walk đi từ trên xuống).
            for parent, dirs, _ in os.walk(d):
                for x in dirs:
                    with suppress(OSError):
                        os.chmod(os.path.join(parent, x), 0o700)
            shutil.rmtree(d, ignore_errors=True)
            if root is WT_ROOT:  # ref lấy từ bundle lúc áp dụng
                await _git("update-ref", "-d", f"refs/gung/{d.name}")


async def worker() -> None:
    await init_db()
    for d in (SB_HOME, WT_ROOT, IO_ROOT, OVL_ROOT):
        d.mkdir(parents=True, exist_ok=True)
    async with pool.connection() as conn:
        n = (await conn.execute(
            "UPDATE dev_tasks SET status = 'failed', finished_at = now(), "
            "result = 'Gừng bị khởi động lại giữa chừng nên việc sửa code dừng lại rồi.' WHERE status = 'running'"
        )).rowcount
    if n:
        log.info("Bỏ %d việc dở từ lần chạy trước", n)
    await _cleanup()
    await _start_proxy()
    log.info("Worker sửa code sẵn sàng (repo %s, model %s)", REPO, settings.dev_model)
    while True:
        try:
            async with pool.connection() as conn:
                # RETURNING trả giá trị sau UPDATE nên lấy trạng thái cũ và lời dặn từ CTE.
                task = await (await conn.execute(
                    "WITH q AS (SELECT id, status, pending_input FROM dev_tasks "
                    "WHERE status IN ('queued', 'approved') ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) "
                    "UPDATE dev_tasks d SET status = 'running', pending_input = NULL FROM q WHERE d.id = q.id "
                    "RETURNING d.*, q.status AS prev, q.pending_input AS revise"
                )).fetchone()
            if task:
                try:
                    if task["prev"] == "queued":
                        await run_claude(task, task["revise"])
                    else:
                        await run_stage(task)
                except Cancelled:
                    log.info("Việc %s đã bị huỷ", task["id"])
                except Exception:
                    log.exception("Việc %s lỗi", task["id"])
                    await _say(task, "failed", "Phần sửa code của Gừng gặp trục trặc nên chưa làm xong việc này.")
                await _cleanup()
        except Exception:
            log.exception("Lỗi vòng nhận việc")
        await asyncio.sleep(POLL_SEC)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    with suppress(KeyboardInterrupt):
        asyncio.run(worker())
