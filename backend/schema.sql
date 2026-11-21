-- Schema cho trợ lý ảo. Chạy tự động khi backend khởi động (idempotent).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tài khoản. Hiện mỗi thiết bị tự có một tài khoản (bảng devices); sau này đăng nhập Apple
-- thì nhiều thiết bị trỏ về cùng một tài khoản để dùng chung bộ nhớ.
CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Dòng model Claude để trò chuyện (chat_models.py); NULL = mặc định.
    chat_model  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mã thiết bị (UUID ngẫu nhiên app tự sinh, lưu Keychain/localStorage) → tài khoản.
CREATE TABLE IF NOT EXISTS devices (
    id            TEXT PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bảng cài đặt chung cũ, nay cài đặt nằm trong users.
DROP TABLE IF EXISTS settings;

-- Mỗi phiên trò chuyện. `summary` = tóm tắt do LLM viết (bộ nhớ tầng 2).
CREATE TABLE IF NOT EXISTS conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT,
    summary     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Toàn bộ tin nhắn (bộ nhớ tầng 1: N tin gần nhất được đưa vào prompt).
CREATE TABLE IF NOT EXISTS messages (
    id               BIGSERIAL PRIMARY KEY,
    conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content          TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_id, id);

-- Ký ức dài hạn (bộ nhớ tầng 3): các sự thật về người dùng, tìm bằng vector.
-- 1024 chiều = mặc định của voyage-3.5. Đổi model embedding thì đổi số này.
CREATE TABLE IF NOT EXISTS memories (
    id          BIGSERIAL PRIMARY KEY,
    content     TEXT NOT NULL,
    embedding   VECTOR(1024) NOT NULL,
    source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_embedding_idx
    ON memories USING hnsw (embedding vector_cosine_ops);

-- Dữ liệu theo tài khoản. Dữ liệu có từ trước khi chia tài khoản có user_id NULL: không ai
-- thấy cho tới khi gán tay cho một tài khoản.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
-- Lọc giọng xung quanh (Krisp voice isolation ở agent): tốn phút của LiveKit Cloud nên mặc định tắt.
ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_isolation BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_user_idx ON memories (user_id, id);

-- Việc Gừng làm trên trình duyệt (app/browser.py). Gừng giao việc (status 'queued'), worker
-- ginger-browser nhận và chạy; xong thì ghi kết quả vào cuộc trò chuyện, agent giọng nói đọc lên
-- (announced). 'waiting' = trình duyệt dừng chờ người dùng xác nhận bước không quay lại được.
CREATE TABLE IF NOT EXISTS browser_tasks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
    instruction      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled')),
    -- Lời người dùng trả lời khi việc đang chờ xác nhận, worker đưa tiếp cho trình duyệt.
    pending_input    TEXT,
    progress         TEXT,
    result           TEXT,
    announced        BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS browser_tasks_user_idx ON browser_tasks (user_id, created_at DESC);

-- Việc Gừng sửa mã nguồn của chính mình (app/dev.py, worker ginger-dev). 'waiting' = chờ người dùng
-- trả lời ở bước `stage`: review (áp dụng bản sửa?) → ota (đẩy bản cập nhật app?) → push (lên GitHub?).
-- 'approved' = người dùng đồng ý, worker làm bước đó.
CREATE TABLE IF NOT EXISTS dev_tasks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
    instruction      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'waiting', 'approved', 'done', 'failed', 'cancelled')),
    stage            TEXT NOT NULL DEFAULT 'review' CHECK (stage IN ('review', 'ota', 'push')),
    pending_input    TEXT,          -- lời dặn sửa thêm (revise)
    session_id       TEXT,          -- phiên Claude Code để --resume
    base_commit      TEXT,
    files            TEXT[],
    last_error       TEXT,          -- lỗi lần áp dụng trước, đưa cho Claude khi sửa tiếp
    applied_from     TEXT,
    applied_to       TEXT,
    progress         TEXT,
    result           TEXT,
    announced        BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS dev_tasks_user_idx ON dev_tasks (user_id, created_at DESC);
