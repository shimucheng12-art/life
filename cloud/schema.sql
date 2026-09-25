-- cloud/schema.sql — 碎碎念云端数据库（Cloudflare D1 / SQLite）
-- worker 首次请求会自动建表；此文件用于部署时显式初始化：
--   npx wrangler d1 execute life-diary-db --file schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    phone TEXT UNIQUE NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sms_codes (
    phone TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER DEFAULT 0,
    sent_at INTEGER NOT NULL,
    daily_date TEXT NOT NULL,
    daily_count INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS app_data (
    user_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
