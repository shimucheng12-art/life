// cloud/worker.ts — 碎碎念·云端 API（手机验证码登录 + 数据云同步）
// 架构：Cloudflare Workers + D1（免费额度足够个人使用）
// 短信：阿里云「号码认证服务·短信认证」——个人实名可用，免资质/免签名/免模板，
//       平台自带系统签名与标准验证码模板，验证码由平台生成与校验（CheckSmsVerifyCode）。
//
// 部署步骤（在仓库 cloud/ 目录执行，凭证通过对话私下提供，绝不写入仓库）：
//   1. npx wrangler d1 create life-diary-db        → 将返回的 database_id 填入 wrangler.toml
//   2. npx wrangler secret put JWT_SECRET           （随机 ≥32 字符）
//      npx wrangler secret put ALIYUN_ACCESS_KEY_ID     （需已开通号码认证服务）
//      npx wrangler secret put ALIYUN_ACCESS_KEY_SECRET
//   3. npx wrangler d1 execute life-diary-db --file schema.sql --remote
//   4. npx wrangler deploy                          → 得到 https://life-diary-api.<子域>.workers.dev
//      把该地址填入前端 life.html 的 CLOUD_API_BASE 并推送 Pages 即可全量生效

// ---- 最小类型（自带，避免依赖 @cloudflare/workers-types）----
interface D1ResultLike { success: boolean }
interface D1Stmt {
    bind(...values: unknown[]): D1Stmt;
    first<T = unknown>(): Promise<T | null>;
    run(): Promise<D1ResultLike>;
}
interface D1Like { prepare(sql: string): D1Stmt }

export interface Env {
    DB: D1Like;
    JWT_SECRET: string;
    ALIYUN_ACCESS_KEY_ID?: string;
    ALIYUN_ACCESS_KEY_SECRET?: string;
}

// ---- 常量 ----
const ALLOWED_ORIGINS = ['https://shimucheng12-art.github.io'];
const SMS_COOLDOWN_MS = 60_000;          // 同号 60 秒内只能发 1 条（平台侧也有同名限制）
const SMS_DAILY_LIMIT = 10;              // 同号每日最多 10 条（本地限流，双保险）
const SMS_MAX_FAILS = 10;                // 同号连续验证失败上限（防爆破，平台侧另有校验）
const JWT_TTL_S = 30 * 24 * 3600;        // 登录态 30 天
const DATA_MAX_BYTES = 2_000_000;        // 单次同步数据上限 2MB
const PHONE_RE = /^1[3-9]\d{9}$/;

const SMS_ERR_MAP: Record<string, string> = {
    'isv.BUSINESS_LIMIT_CONTROL': '发送太频繁，请稍后再试',
    'isv.DAY_LIMIT_CONTROL': '今日发送条数已达上限',
    'isv.MINUTE_LIMIT_CONTROL': '发送太频繁，请稍后再试',
    'isv.SMS_VERIFY_CODE_INTERVAL_LIMIT': '发送太频繁，请稍后再试',
    'isv.SMS_VERIFY_CODE_DAILY_LIMIT': '今日发送条数已达上限',
    'isv.MOBILE_NUMBER_ILLEGAL': '手机号格式不正确',
    'isv.PHONE_NUMBER_ILLEGAL': '手机号格式不正确',
    'isv.AMOUNT_NOT_ENOUGH': '套餐余量不足，请联系管理员充值',
    'isv.SMS_SIGNATURE_ILLEGAL': '短信签名配置有误，请联系管理员',
    'isv.SMS_TEMPLATE_ILLEGAL': '短信模板配置有误，请联系管理员',
    'InvalidAccessKeyId.NotFound': 'AccessKey 配置有误，请联系管理员',
    'InvalidAccessKeyId.Disabled': 'AccessKey 已被禁用，请联系管理员',
    'SignatureDoesNotMatch': '短信服务密钥配置有误，请联系管理员',
    'Forbidden': '账号未开通号码认证服务或无权限，请联系管理员',
    'IncompleteSignature': '短信服务密钥配置有误，请联系管理员',
    'Throttling': '请求太频繁，请稍后重试',
};

// ---- 基础工具 ----
const te = (s: string) => new TextEncoder().encode(s);
function b64(buf: ArrayBuffer): string {
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
function b64url(buf: ArrayBuffer): string {
    return b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmac(algo: 'SHA-1' | 'SHA-256', keyStr: string, msg: string): Promise<ArrayBuffer> {
    const key = await crypto.subtle.importKey('raw', te(keyStr), { name: 'HMAC', hash: algo }, false, ['sign']);
    return crypto.subtle.sign('HMAC', key, te(msg));
}
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// ---- JWT（HS256，无第三方依赖）----
async function jwtSign(secret: string, payload: Record<string, unknown>): Promise<string> {
    const h = b64url(te(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const p = b64url(te(JSON.stringify(payload)));
    const sig = b64url(await hmac('SHA-256', secret, h + '.' + p));
    return `${h}.${p}.${sig}`;
}
async function jwtVerify(secret: string, token: string): Promise<Record<string, any> | null> {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const sig = b64url(await hmac('SHA-256', secret, parts[0] + '.' + parts[1]));
        if (!timingSafeEqual(sig, parts[2])) return null;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
        if (payload.sub == null) return null;
        return payload;
    } catch { return null; }
}

// ---- 阿里云号码认证·短信认证（POP RPC V1.0 签名，dypnsapi）----
function popEncode(s: string): string {
    return encodeURIComponent(s)
        .replace(/\+/g, '%20')
        .replace(/\*/g, '%2A')
        .replace(/%7E/g, '~');
}

interface PnsResult {
    /** 请求是否到达平台并拿到结构化响应（传输层成功） */
    ok: boolean;
    /** 错误码（ok=false 时） */
    error?: string;
    /** HTTP 状态码（网络/非 JSON 情况下用于诊断） */
    httpStatus?: number;
}

/**
 * 发送短信验证码（平台生成验证码、平台下发短信，服务端不接触验证码明文）。
 * 成功时返回 { ok: true }；失败返回错误码。
 */
async function pnsSendSmsVerifyCode(env: Env, phone: string): Promise<PnsResult> {
    const params: Record<string, string> = {
        AccessKeyId: env.ALIYUN_ACCESS_KEY_ID || '',
        Action: 'SendSmsVerifyCode',
        CodeLength: '6',
        CodeType: '1',                       // 纯数字
        CountryCode: '86',
        Format: 'JSON',
        Interval: '60',                      // 重发间隔（秒）
        PhoneNumber: phone,
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: crypto.randomUUID(),
        SignatureVersion: '1.0',
        Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        ValidTime: '300',                    // 验证码 5 分钟有效
        Version: '2017-05-25',
    };
    return pnsCall(env, params);
}

/**
 * 校验短信验证码（平台侧比对）。PASS 表示验证通过。
 */
async function pnsCheckSmsVerifyCode(env: Env, phone: string, code: string): Promise<PnsResult & { pass?: boolean }> {
    const params: Record<string, string> = {
        AccessKeyId: env.ALIYUN_ACCESS_KEY_ID || '',
        Action: 'CheckSmsVerifyCode',
        CountryCode: '86',
        Format: 'JSON',
        PhoneNumber: phone,
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: crypto.randomUUID(),
        SignatureVersion: '1.0',
        Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        ValidTime: '300',
        VerifyCode: code,
        Version: '2017-05-25',
    };
    const r = await pnsCall(env, params);
    // 传输层失败（网络/网关/非 JSON）→ ok=false → 登录接口回 502
    if (!r.parsed) return { ok: false, error: r.error, httpStatus: r.httpStatus };
    // 平台已给出结构化应答：Code=OK 且 VerifyResult=PASS 才算通过
    //（兼容扁平与嵌套 Model 两种返回形态；业务性失败一律按「验证未通过」处理）
    const body: any = r.body;
    const pass = body?.Code === 'OK'
        && (body?.VerifyResult === 'PASS' || body?.Model?.VerifyResult === 'PASS');
    return { ok: true, pass: !!pass };
}

async function pnsCall(env: Env, params: Record<string, string>): Promise<PnsResult & { body?: any; parsed?: boolean }> {
    const canonical = Object.keys(params).sort()
        .map(k => popEncode(k) + '=' + popEncode(params[k])).join('&');
    const stringToSign = 'POST&' + popEncode('/') + '&' + popEncode(canonical);
    const sig = b64(await hmac('SHA-1', (env.ALIYUN_ACCESS_KEY_SECRET || '') + '&', stringToSign));
    const url = 'https://dypnsapi.aliyuncs.com/?Signature=' + popEncode(sig) + '&' + canonical;
    let res: Response;
    try {
        res = await fetch(url, { method: 'POST' });
    } catch {
        return { ok: false, parsed: false, error: 'network' };
    }
    let body: any = null;
    try { body = await res.json(); } catch { /* 非 JSON：按传输失败处理 */ }
    if (body === null || typeof body !== 'object') {
        return { ok: false, parsed: false, error: 'HTTP_' + res.status, httpStatus: res.status };
    }
    const code = String(body.Code || '');
    const parsed = true;
    const success = code === 'OK' || body?.Success === true;
    if (success) return { ok: true, parsed, body };
    return { ok: false, parsed, error: code || 'EMPTY_CODE', httpStatus: res.status, body };
}

// ---- 数据库初始化（幂等）----
let schemaReady = false;
async function initSchema(env: Env): Promise<void> {
    if (schemaReady) return;
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
    )`).run();
    // 限流台账：验证码本体由阿里云平台持有，本地只做发送限流与防爆破
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sms_throttle (
        phone TEXT PRIMARY KEY,
        sent_at INTEGER NOT NULL,
        daily_date TEXT NOT NULL,
        daily_count INTEGER DEFAULT 1,
        fail_count INTEGER DEFAULT 0,
        last_fail_at INTEGER DEFAULT 0
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_data (
        user_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`).run();
    schemaReady = true;
}

// ---- HTTP 工具 ----
function corsHeaders(origin: string): Record<string, string> {
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Content-Type': 'application/json; charset=utf-8',
    };
}
function json(data: unknown, status: number, origin: string): Response {
    return new Response(JSON.stringify(data), { status, headers: corsHeaders(origin) });
}
function todayKey(): string {
    return new Date().toISOString().slice(0, 10);
}

// ---- 业务处理 ----
async function handleSmsSend(env: Env, body: any, origin: string): Promise<Response> {
    const phone = String(body?.phone || '').trim();
    if (!PHONE_RE.test(phone)) return json({ error: '请输入正确的 11 位手机号' }, 400, origin);
    if (!env.ALIYUN_ACCESS_KEY_ID || !env.ALIYUN_ACCESS_KEY_SECRET) {
        return json({ error: '短信服务尚未配置，请联系管理员' }, 503, origin);
    }
    const now = Date.now();
    const row = await env.DB.prepare('SELECT * FROM sms_throttle WHERE phone = ?').bind(phone).first<any>();
    if (row) {
        if (now - row.sent_at < SMS_COOLDOWN_MS) {
            return json({ error: '发送太频繁，请稍后再试', retry_after: Math.ceil((SMS_COOLDOWN_MS - (now - row.sent_at)) / 1000) }, 429, origin);
        }
        if (row.daily_date === todayKey() && row.daily_count >= SMS_DAILY_LIMIT) {
            return json({ error: '今日发送条数已达上限，明天再试' }, 429, origin);
        }
    }
    // 平台发送（验证码由阿里云生成并下发）
    const r = await pnsSendSmsVerifyCode(env, phone);
    if (!r.ok) {
        const friendly = SMS_ERR_MAP[r.error || ''] || ('短信发送失败（' + (r.error || 'unknown') + '）');
        return json({ error: friendly }, 502, origin);
    }
    await env.DB.prepare(`INSERT INTO sms_throttle (phone, sent_at, daily_date, daily_count, fail_count, last_fail_at)
        VALUES (?, ?, ?, 1, 0, 0)
        ON CONFLICT(phone) DO UPDATE SET
            sent_at = excluded.sent_at,
            daily_date = excluded.daily_date,
            daily_count = CASE WHEN sms_throttle.daily_date = excluded.daily_date THEN sms_throttle.daily_count + 1 ELSE 1 END,
            fail_count = 0,
            last_fail_at = 0`
    ).bind(phone, now, todayKey()).run();
    return json({ ok: true, message: '验证码已发送' }, 200, origin);
}

async function handleSmsLogin(env: Env, body: any, origin: string): Promise<Response> {
    const phone = String(body?.phone || '').trim();
    const code = String(body?.code || '').trim();
    if (!PHONE_RE.test(phone)) return json({ error: '请输入正确的 11 位手机号' }, 400, origin);
    if (!/^\d{6}$/.test(code)) return json({ error: '请输入 6 位验证码' }, 400, origin);
    if (!env.ALIYUN_ACCESS_KEY_ID || !env.ALIYUN_ACCESS_KEY_SECRET) {
        return json({ error: '短信服务尚未配置，请联系管理员' }, 503, origin);
    }
    const row = await env.DB.prepare('SELECT * FROM sms_throttle WHERE phone = ?').bind(phone).first<any>();
    // 本地防爆破：连续失败超过上限直接拒绝（需重新获取验证码以清零）
    if (row && row.fail_count >= SMS_MAX_FAILS) {
        return json({ error: '错误次数过多，请重新获取验证码' }, 429, origin);
    }
    // 平台侧校验验证码
    const r = await pnsCheckSmsVerifyCode(env, phone, code);
    if (!r.ok) {
        const friendly = SMS_ERR_MAP[r.error || ''] || ('验证服务异常（' + (r.error || 'unknown') + '）');
        return json({ error: friendly }, 502, origin);
    }
    if (!r.pass) {
        await env.DB.prepare(`INSERT INTO sms_throttle (phone, sent_at, daily_date, daily_count, fail_count, last_fail_at)
            VALUES (?, ?, ?, 0, 1, ?)
            ON CONFLICT(phone) DO UPDATE SET fail_count = sms_throttle.fail_count + 1, last_fail_at = excluded.last_fail_at`
        ).bind(phone, row?.sent_at ?? 0, todayKey(), Date.now()).run();
        return json({ error: '验证码错误或已过期' }, 401, origin);
    }
    // 验证通过：清零失败计数、取/建用户
    await env.DB.prepare(`INSERT INTO sms_throttle (phone, sent_at, daily_date, daily_count, fail_count, last_fail_at)
        VALUES (?, 0, ?, 0, 0, 0)
        ON CONFLICT(phone) DO UPDATE SET fail_count = 0, last_fail_at = 0`
    ).bind(phone, todayKey()).run();
    let user = await env.DB.prepare('SELECT id FROM users WHERE phone = ?').bind(phone).first<any>();
    let userId: string;
    if (user) {
        userId = user.id;
    } else {
        userId = crypto.randomUUID();
        await env.DB.prepare('INSERT INTO users (id, phone) VALUES (?, ?)').bind(userId, phone).run();
    }
    const now = Date.now();
    const exp = Math.floor(now / 1000) + JWT_TTL_S;
    const token = await jwtSign(env.JWT_SECRET, { sub: userId, phone, iat: Math.floor(now / 1000), exp });
    return json({ token, phone, user_id: userId, expires_at: exp }, 200, origin);
}

async function requireUser(request: Request, env: Env): Promise<{ payload: Record<string, any> } | Response> {
    const auth = request.headers.get('Authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return json({ error: '未登录' }, 401, '');
    const payload = await jwtVerify(env.JWT_SECRET, m[1]);
    if (!payload) return json({ error: '登录已过期，请重新登录' }, 401, '');
    return { payload };
}
function isResponse(x: any): x is Response { return x instanceof Response; }

async function handleGetData(env: Env, userId: string, origin: string): Promise<Response> {
    const row = await env.DB.prepare('SELECT data, updated_at FROM app_data WHERE user_id = ?').bind(userId).first<any>();
    return json({ data: row ? row.data : null, updated_at: row ? row.updated_at : null }, 200, origin);
}

async function handlePutData(env: Env, userId: string, body: any, origin: string): Promise<Response> {
    if (body == null || typeof body !== 'object' || !('data' in body)) {
        return json({ error: '请求格式错误' }, 400, origin);
    }
    const dataStr = typeof body.data === 'string' ? body.data : JSON.stringify(body.data);
    if (dataStr.length > DATA_MAX_BYTES) return json({ error: '数据超过 2MB 上限' }, 413, origin);
    try { JSON.parse(dataStr); } catch { return json({ error: '数据不是合法 JSON' }, 400, origin); }
    const now = Date.now();
    const row = await env.DB.prepare('SELECT data, updated_at FROM app_data WHERE user_id = ?').bind(userId).first<any>();
    const base = body.base_updated_at === undefined || body.base_updated_at === null ? null : Number(body.base_updated_at);
    if (row && base !== null && Number(row.updated_at) !== base) {
        // 乐观锁冲突：返回服务端版本让客户端决定
        return json({ error: 'conflict', updated_at: row.updated_at, data: row.data }, 409, origin);
    }
    await env.DB.prepare(`INSERT INTO app_data (user_id, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(userId, dataStr, now).run();
    return json({ ok: true, updated_at: now }, 200, origin);
}

// ---- 路由入口 ----
export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const origin = request.headers.get('Origin') || '';
        const url = new URL(request.url);
        const path = url.pathname;
        try {
            if (request.method === 'OPTIONS') {
                return new Response(null, { status: 204, headers: corsHeaders(origin) });
            }
            await initSchema(env);
            if (path === '/api/health') {
                return json({ ok: true, time: Date.now() }, 200, origin);
            }
            if (request.method === 'POST' && path === '/api/auth/sms/send') {
                const body = await request.json().catch(() => null);
                return handleSmsSend(env, body, origin);
            }
            if (request.method === 'POST' && path === '/api/auth/sms/login') {
                const body = await request.json().catch(() => null);
                return handleSmsLogin(env, body, origin);
            }
            if (path === '/api/data') {
                const auth = await requireUser(request, env);
                if (isResponse(auth)) {
                    // 401 响应也要带 CORS（用请求来源）
                    return json(JSON.parse(await auth.text()), auth.status, origin);
                }
                if (request.method === 'GET') return handleGetData(env, String(auth.payload.sub), origin);
                if (request.method === 'PUT') {
                    const body = await request.json().catch(() => null);
                    return handlePutData(env, String(auth.payload.sub), body, origin);
                }
            }
            return json({ error: 'not found' }, 404, origin);
        } catch (e) {
            return json({ error: '服务器内部错误' }, 500, origin);
        }
    },
};

// ---- 供本地单元测试使用的内部导出（线上不影响）----
export const __internals = { jwtSign, jwtVerify, popEncode, timingSafeEqual, pnsSendSmsVerifyCode, pnsCheckSmsVerifyCode };
