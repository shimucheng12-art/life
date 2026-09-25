// cloud-fc/src/index.ts — 碎碎念·云端 API（阿里云函数计算 FC 3.0 版）
//
// 运行形态：事件函数 nodejs20 + HTTP 触发器（anonymous 免鉴权，默认公网域名 *.fcapp.run）
// 存储：OSS JSON 对象（u/ 用户、t/ 限流台账、d/ 数据），ETag 条件写（If-Match/If-None-Match）保证并发安全
// 短信：阿里云「号码认证·短信认证」SendSmsVerifyCode/CheckSmsVerifyCode（免资质/免签名/免模板）
// 接口路径与响应格式与 cloud/worker.ts（Cloudflare 版）完全一致，前端只需切换 CLOUD_API_BASE。
//
// 导出：
//   handler        FC 入口（生产环境使用）
//   __internals    测试钩子（createApi / MemoryStore / jwt / pns 等）

import OSS from 'ali-oss';

// ---------------- 类型 ----------------
export interface KVStore {
    /** 读取；不存在返回 null。etag 为 OSS 返回的原始 ETag（含引号） */
    get(key: string): Promise<{ value: any; etag: string } | null>;
    /** CAS 写入：etag 匹配才写。false = 版本冲突（412） */
    putIfMatch(key: string, value: any, etag: string): Promise<boolean>;
    /** 仅当不存在时创建。false = 已存在 */
    putIfAbsent(key: string, value: any): Promise<boolean>;
}

export interface Env {
    JWT_SECRET: string;
    ALIYUN_AK_ID: string;
    ALIYUN_AK_SECRET: string;
    OSS_BUCKET: string;
    OSS_REGION: string;
}

/** 可注入的短信实现（测试时用桩替换，不触网） */
export interface SmsDeps {
    smsSend(phone: string): Promise<PnsResult>;
    smsCheck(phone: string, code: string): Promise<PnsResult & { pass?: boolean }>;
}

interface Req {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: any;
}

interface Res {
    status: number;
    headers: Record<string, string>;
    body: any;
}

// ---------------- 常量（与 Worker 版一致） ----------------
const ALLOWED_ORIGINS = ['https://shimucheng12-art.github.io'];
const SMS_COOLDOWN_MS = 60_000;
const SMS_DAILY_LIMIT = 10;
const SMS_MAX_FAILS = 10;
const JWT_TTL_S = 30 * 24 * 3600;
const DATA_MAX_BYTES = 2_000_000;
const PHONE_RE = /^1[3-9]\d{9}$/;
const K_USERS = (p: string) => `u/${p}`;
const K_THR = (p: string) => `t/${p}`;
const K_DATA = (id: string) => `d/${id}`;

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

// ---------------- 基础工具 ----------------
const te = (s: string) => new TextEncoder().encode(s);
function b64(buf: ArrayBuffer): string { return Buffer.from(buf).toString('base64'); }
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

// ---------------- JWT（HS256，无第三方依赖） ----------------
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
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
        if (payload.sub == null) return null;
        return payload;
    } catch { return null; }
}

// ---------------- 阿里云号码认证·短信认证（POP RPC V1.0 签名） ----------------
function popEncode(s: string): string {
    return encodeURIComponent(s)
        .replace(/\+/g, '%20')
        .replace(/\*/g, '%2A')
        .replace(/%7E/g, '~');
}

interface PnsResult {
    ok: boolean;
    error?: string;
    httpStatus?: number;
}

async function pnsSendSmsVerifyCode(env: Env, phone: string): Promise<PnsResult> {
    const params: Record<string, string> = {
        AccessKeyId: env.ALIYUN_AK_ID,
        Action: 'SendSmsVerifyCode',
        CodeLength: '6',
        CodeType: '1',
        CountryCode: '86',
        Format: 'JSON',
        Interval: '60',
        PhoneNumber: phone,
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: crypto.randomUUID(),
        SignatureVersion: '1.0',
        Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        ValidTime: '300',
        Version: '2017-05-25',
    };
    return pnsCall(env, params);
}

async function pnsCheckSmsVerifyCode(env: Env, phone: string, code: string): Promise<PnsResult & { pass?: boolean }> {
    const params: Record<string, string> = {
        AccessKeyId: env.ALIYUN_AK_ID,
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
    if (!r.parsed) return { ok: false, error: r.error, httpStatus: r.httpStatus };
    const body: any = r.body;
    const pass = body?.Code === 'OK'
        && (body?.VerifyResult === 'PASS' || body?.Model?.VerifyResult === 'PASS');
    return { ok: true, pass: !!pass };
}

async function pnsCall(env: Env, params: Record<string, string>): Promise<PnsResult & { body?: any; parsed?: boolean }> {
    const canonical = Object.keys(params).sort()
        .map(k => popEncode(k) + '=' + popEncode(params[k])).join('&');
    const stringToSign = 'POST&' + popEncode('/') + '&' + popEncode(canonical);
    const sig = b64(await hmac('SHA-1', env.ALIYUN_AK_SECRET + '&', stringToSign));
    const url = 'https://dypnsapi.aliyuncs.com/?Signature=' + popEncode(sig) + '&' + canonical;
    let res: any;
    try {
        res = await fetch(url, { method: 'POST' });
    } catch {
        return { ok: false, parsed: false, error: 'network' };
    }
    let body: any = null;
    try { body = await res.json(); } catch { /* 非 JSON 按传输失败处理 */ }
    if (body === null || typeof body !== 'object') {
        return { ok: false, parsed: false, error: 'HTTP_' + res.status, httpStatus: res.status };
    }
    const code = String(body.Code || '');
    const success = code === 'OK' || body?.Success === true;
    if (success) return { ok: true, parsed: true, body };
    return { ok: false, parsed: true, error: code || 'EMPTY_CODE', httpStatus: res.status, body };
}

// ---------------- 存储：内存实现（测试）/ OSS 实现（生产） ----------------
export class MemoryStore implements KVStore {
    map = new Map<string, { value: any; etag: string }>();
    private ver = 0;

    async get(key: string) { return this.map.get(key) ?? null; }

    async putIfMatch(key: string, value: any, etag: string): Promise<boolean> {
        const cur = this.map.get(key);
        if (!cur || cur.etag !== etag) return false;
        const next = { value, etag: `v${++this.ver}` };
        this.map.set(key, next);
        return true;
    }

    async putIfAbsent(key: string, value: any): Promise<boolean> {
        if (this.map.has(key)) return false;
        this.map.set(key, { value, etag: `v${++this.ver}` });
        return true;
    }
}

export class OssStore implements KVStore {
    private client: any;

    constructor(env: { OSS_BUCKET: string; OSS_REGION: string; ALIYUN_AK_ID: string; ALIYUN_AK_SECRET: string }) {
        this.client = new OSS({
            region: env.OSS_REGION || 'oss-cn-hangzhou',
            bucket: env.OSS_BUCKET,
            accessKeyId: env.ALIYUN_AK_ID,
            accessKeySecret: env.ALIYUN_AK_SECRET,
            timeout: '15s',
        });
    }

    async get(key: string) {
        try {
            const r = await this.client.get(key);
            const etag = r?.res?.headers?.etag || '';
            return { value: JSON.parse(r.content?.toString('utf8') || 'null'), etag };
        } catch (e: any) {
            if (e?.status === 404 || e?.code === 'NoSuchKey') return null;
            throw e;
        }
    }

    async putIfMatch(key: string, value: any, etag: string): Promise<boolean> {
        try {
            await this.client.put(key, Buffer.from(JSON.stringify(value), 'utf8'), { headers: { 'If-Match': etag } });
            return true;
        } catch (e: any) {
            if (e?.status === 412) return false;
            throw e;
        }
    }

    async putIfAbsent(key: string, value: any): Promise<boolean> {
        try {
            await this.client.put(key, Buffer.from(JSON.stringify(value), 'utf8'), { headers: { 'If-None-Match': '*' } });
            return true;
        } catch (e: any) {
            if (e?.status === 412) return false;
            throw e;
        }
    }
}

// ---------------- HTTP 工具 ----------------
function corsHeaders(origin: string): Record<string, string> {
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
    };
}
function json(data: unknown, status: number, origin: string): Res {
    return { status, headers: corsHeaders(origin), body: data };
}
function todayKey(): string { return new Date().toISOString().slice(0, 10); }

// ---------------- 业务处理 ----------------
async function handleSmsSend(store: KVStore, env: Env, body: any, origin: string, sms: SmsDeps): Promise<Res> {
    const phone = String(body?.phone || '').trim();
    if (!PHONE_RE.test(phone)) return json({ error: '请输入正确的 11 位手机号' }, 400, origin);
    if (!env.ALIYUN_AK_ID || !env.ALIYUN_AK_SECRET) {
        return json({ error: '短信服务尚未配置，请联系管理员' }, 503, origin);
    }
    const now = Date.now();
    const thr = await store.get(K_THR(phone));
    if (thr) {
        const t = thr.value;
        if (now - t.sent_at < SMS_COOLDOWN_MS) {
            return json({ error: '发送太频繁，请稍后再试', retry_after: Math.ceil((SMS_COOLDOWN_MS - (now - t.sent_at)) / 1000) }, 429, origin);
        }
        if (t.daily_date === todayKey() && t.daily_count >= SMS_DAILY_LIMIT) {
            return json({ error: '今日发送条数已达上限，明天再试' }, 429, origin);
        }
    }
    const r = await sms.smsSend(phone);
    if (!r.ok) {
        // 传输层失败（网络/网关/非 JSON）→ 502
        return json({ error: '短信服务暂时不可用，请稍后再试' }, 502, origin);
    }
    if (r.error) {
        // 平台结构化业务错误（限流/余量/配置等）→ 429 + 友好文案
        const friendly = SMS_ERR_MAP[r.error] || ('发送失败（' + r.error + '）');
        return json({ error: friendly }, 429, origin);
    }
    // 更新台账（读-改-写；冲突重试一次）
    const today = todayKey();
    for (let i = 0; i < 2; i++) {
        const cur = await store.get(K_THR(phone));
        const next = cur
            ? {
                sent_at: now,
                daily_date: today,
                daily_count: cur.value.daily_date === today ? cur.value.daily_count + 1 : 1,
                fail_count: 0,
                last_fail_at: 0,
            }
            : { sent_at: now, daily_date: today, daily_count: 1, fail_count: 0, last_fail_at: 0 };
        const ok = cur ? await store.putIfMatch(K_THR(phone), next, cur.etag) : await store.putIfAbsent(K_THR(phone), next);
        if (ok) break;
    }
    return json({ ok: true, message: '验证码已发送' }, 200, origin);
}

async function handleSmsLogin(store: KVStore, env: Env, body: any, origin: string, sms: SmsDeps): Promise<Res> {
    const phone = String(body?.phone || '').trim();
    const code = String(body?.code || '').trim();
    if (!PHONE_RE.test(phone)) return json({ error: '请输入正确的 11 位手机号' }, 400, origin);
    if (!/^\d{6}$/.test(code)) return json({ error: '请输入 6 位验证码' }, 400, origin);
    if (!env.ALIYUN_AK_ID || !env.ALIYUN_AK_SECRET) {
        return json({ error: '短信服务尚未配置，请联系管理员' }, 503, origin);
    }
    const thr = await store.get(K_THR(phone));
    if (thr && thr.value.fail_count >= SMS_MAX_FAILS) {
        return json({ error: '错误次数过多，请重新获取验证码' }, 429, origin);
    }
    const r = await sms.smsCheck(phone, code);
    if (!r.ok) {
        const friendly = SMS_ERR_MAP[r.error || ''] || ('验证服务异常（' + (r.error || 'unknown') + '）');
        return json({ error: friendly }, 502, origin);
    }
    if (!r.pass) {
        // 失败计数 +1（读-改-写；冲突重试一次）
        const now = Date.now();
        for (let i = 0; i < 2; i++) {
            const cur = await store.get(K_THR(phone));
            const next = cur
                ? { ...cur.value, fail_count: (cur.value.fail_count || 0) + 1, last_fail_at: now }
                : { sent_at: 0, daily_date: todayKey(), daily_count: 0, fail_count: 1, last_fail_at: now };
            const ok = cur ? await store.putIfMatch(K_THR(phone), next, cur.etag) : await store.putIfAbsent(K_THR(phone), next);
            if (ok) break;
        }
        return json({ error: '验证码错误或已过期' }, 401, origin);
    }
    // 验证通过：清零失败计数
    for (let i = 0; i < 2; i++) {
        const cur = await store.get(K_THR(phone));
        const next = cur
            ? { ...cur.value, fail_count: 0, last_fail_at: 0 }
            : { sent_at: 0, daily_date: todayKey(), daily_count: 0, fail_count: 0, last_fail_at: 0 };
        const ok = cur ? await store.putIfMatch(K_THR(phone), next, cur.etag) : await store.putIfAbsent(K_THR(phone), next);
        if (ok) break;
    }
    // 取/建用户
    let user = await store.get(K_USERS(phone));
    let userId: string;
    if (user) {
        userId = user.value.id;
    } else {
        userId = crypto.randomUUID();
        const created = await store.putIfAbsent(K_USERS(phone), { id: userId, created_at: Date.now() });
        if (!created) {
            const again = await store.get(K_USERS(phone));
            userId = again ? again.value.id : userId;
        }
    }
    const now = Date.now();
    const exp = Math.floor(now / 1000) + JWT_TTL_S;
    const token = await jwtSign(env.JWT_SECRET, { sub: userId, phone, iat: Math.floor(now / 1000), exp });
    return json({ token, phone, user_id: userId, expires_at: exp }, 200, origin);
}

async function authPayload(env: Env, headers: Record<string, string>): Promise<Record<string, any> | null> {
    const auth = headers['authorization'] || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    return jwtVerify(env.JWT_SECRET, m[1]);
}

async function handleGetData(store: KVStore, userId: string, origin: string): Promise<Res> {
    const row = await store.get(K_DATA(userId));
    const v = row ? row.value : null;
    return json({ data: v ? v.data : null, updated_at: v ? v.updated_at : null }, 200, origin);
}

async function handlePutData(store: KVStore, userId: string, body: any, origin: string): Promise<Res> {
    if (body == null || typeof body !== 'object' || !('data' in body)) {
        return json({ error: '请求格式错误' }, 400, origin);
    }
    const dataStr = typeof body.data === 'string' ? body.data : JSON.stringify(body.data);
    if (dataStr.length > DATA_MAX_BYTES) return json({ error: '数据超过 2MB 上限' }, 413, origin);
    try { JSON.parse(dataStr); } catch { return json({ error: '数据不是合法 JSON' }, 400, origin); }
    const cur = await store.get(K_DATA(userId));
    // 时间戳严格单调递增：同毫秒连续写入时 base 版本比对不失效
    const now = Math.max(Date.now(), Number(cur?.value?.updated_at ?? 0) + 1);
    const base = body.base_updated_at === undefined || body.base_updated_at === null ? null : Number(body.base_updated_at);
    if (cur) {
        // 已有数据：base 必须与当前版本一致（base=null 视为创建覆盖 → 冲突）
        if (base === null || Number(cur.value.updated_at) !== base) {
            return json({ error: 'conflict', updated_at: cur.value.updated_at, data: cur.value.data }, 409, origin);
        }
        const ok = await store.putIfMatch(K_DATA(userId), { data: dataStr, updated_at: now }, cur.etag);
        if (!ok) {
            const fresh = await store.get(K_DATA(userId));
            return json({ error: 'conflict', updated_at: fresh ? fresh.value.updated_at : null, data: fresh ? fresh.value.data : null }, 409, origin);
        }
        return json({ ok: true, updated_at: now }, 200, origin);
    }
    // 无数据：创建（并发下仅一个成功）
    const ok = await store.putIfAbsent(K_DATA(userId), { data: dataStr, updated_at: now });
    if (!ok) {
        const fresh = await store.get(K_DATA(userId));
        return json({ error: 'conflict', updated_at: fresh ? fresh.value.updated_at : null, data: fresh ? fresh.value.data : null }, 409, origin);
    }
    return json({ ok: true, updated_at: now }, 200, origin);
}

// ---------------- 路由核心（纯函数式，可测试） ----------------
function lowerKeys(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
    return out;
}
function parseBody(b: unknown): any {
    if (typeof b === 'string') { try { return JSON.parse(b); } catch { return null; } }
    return b;
}
export function createApi(store: KVStore, env: Env, sms?: Partial<SmsDeps>) {
    const deps: SmsDeps = {
        smsSend: sms?.smsSend || ((phone) => pnsSendSmsVerifyCode(env, phone)),
        smsCheck: sms?.smsCheck || ((phone, code) => pnsCheckSmsVerifyCode(env, phone, code)),
    };
    const route = async (req: Req): Promise<Res> => {
        const origin = req.headers['origin'] || '';
        try {
            const body = parseBody(req.body);
            if (req.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders(origin), body: null };
            }
            if (req.path === '/api/health') {
                return json({ ok: true, time: Date.now() }, 200, origin);
            }
            if (req.method === 'POST' && req.path === '/api/auth/sms/send') {
                return handleSmsSend(store, env, body, origin, deps);
            }
            if (req.method === 'POST' && req.path === '/api/auth/sms/login') {
                return handleSmsLogin(store, env, body, origin, deps);
            }
            if (req.path === '/api/data') {
                const payload = await authPayload(env, req.headers);
                if (!payload) return json({ error: '未登录或登录已过期' }, 401, origin);
                if (req.method === 'GET') return handleGetData(store, String(payload.sub), origin);
                if (req.method === 'PUT') return handlePutData(store, String(payload.sub), body, origin);
            }
            return json({ error: 'not found' }, 404, origin);
        } catch (e: any) {
            console.error('api error:', e?.stack || e);
            return json({ error: '服务器内部错误' }, 500, origin);
        }
    };
    return {
        handle: async (req: Req): Promise<Res> => {
            const res = await route(req);
            return { status: res.status, headers: lowerKeys(res.headers), body: res.body };
        },
    };
}

// ---------------- FC 入口（事件函数 + HTTP 触发器，事件协议） ----------------
// FC 3.0 实测：HTTP 触发器以 Buffer(JSON) 传入，结构为
//   { version, rawPath, headers, queryParameters, body, isBase64Encoded,
//     requestContext: { accountId, domainName, http: { method, path, protocol, sourceIp } } }
// 响应回传 JSON 信封字符串：{ statusCode, headers, body, isBase64Encoded }
function getEnv(): Env {
    return {
        JWT_SECRET: process.env.JWT_SECRET || '',
        ALIYUN_AK_ID: process.env.ALIYUN_AK_ID || '',
        ALIYUN_AK_SECRET: process.env.ALIYUN_AK_SECRET || '',
        OSS_BUCKET: process.env.OSS_BUCKET || '',
        OSS_REGION: process.env.OSS_REGION || 'oss-cn-hangzhou',
    };
}

let storeSingleton: OssStore | null = null;
let apiSingleton: ReturnType<typeof createApi> | null = null;

export const handler = async function (event: any, context: any, callback?: any): Promise<string | void> {
    let method = 'GET';
    let path = '/';
    const headers: Record<string, string> = {};
    let bodyRaw: any = null;
    try {
        const ev = Buffer.isBuffer(event) ? JSON.parse(event.toString('utf8'))
            : typeof event === 'string' ? JSON.parse(event)
            : event;
        if (ev && typeof ev === 'object' && ev.rawPath !== undefined) {
            method = String(ev.requestContext?.http?.method || 'GET').toUpperCase();
            path = String(ev.rawPath || '/');
            if (path.includes('?')) path = path.slice(0, path.indexOf('?'));
            const hs = ev.headers || {};
            for (const k of Object.keys(hs)) headers[k.toLowerCase()] = String(hs[k] || '');
            let b: any = ev.body;
            if (typeof b === 'string' && b.length) {
                if (ev.isBase64Encoded) { try { b = Buffer.from(b, 'base64').toString('utf8'); } catch { b = ''; } }
                bodyRaw = b;
            }
        }
    } catch { /* 事件解析失败按 404 路由处理 */ }

    const env = getEnv();
    if (!apiSingleton) {
        if (env.OSS_BUCKET) {
            storeSingleton = new OssStore(env);
            apiSingleton = createApi(storeSingleton, env);
        } else {
            apiSingleton = createApi({ get: async () => null } as unknown as KVStore, env);
        }
    }
    let res: Res;
    try {
        res = await apiSingleton.handle({ method, path, headers, body: bodyRaw });
    } catch (e: any) {
        console.error('handler error:', e?.stack || e);
        res = { status: 500, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': ALLOWED_ORIGINS[0] }, body: { error: '服务器内部错误' } };
    }
    const envelope = JSON.stringify({
        statusCode: res.status,
        headers: res.headers,
        body: res.body == null ? '' : JSON.stringify(res.body),
        isBase64Encoded: false,
    });
    if (typeof callback === 'function') { callback(null, envelope); return; }
    return envelope;
};

export const __internals = {
    jwtSign, jwtVerify, popEncode, timingSafeEqual,
    pnsSendSmsVerifyCode, pnsCheckSmsVerifyCode,
    MemoryStore, OssStore, createApi,
    K_USERS, K_THR, K_DATA, handler,
};
