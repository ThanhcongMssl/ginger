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
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_user_idx ON memories (user_id, id);
