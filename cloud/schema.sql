-- cloud/schema.sql — 碎碎念云端数据库（Cloudflare D1 / SQLite）
-- worker 首次请求会自动建表；此文件用于部署时显式初始化：
--   npx wrangler d1 execute life-diary-db --file schema.sql --remote
-- 说明：验证码本体由阿里云短信认证平台生成与校验，云端只保存限流台账。

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    phone TEXT UNIQUE NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sms_throttle (
    phone TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL,
    daily_date TEXT NOT NULL,
    daily_count INTEGER DEFAULT 1,
    fail_count INTEGER DEFAULT 0,
    last_fail_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_data (
    user_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
