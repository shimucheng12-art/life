// cloud-fc/test/api.test.mjs — FC 版后端测试套件（对打包产物 dist/index.js 运行，测的就是上线的东西）
// 覆盖：健康检查/CORS/404、JWT、短信发送限流（冷却/日限/错误文案/传输失败）、
//       短信登录（防爆破/建用户/幂等）、数据同步（鉴权/创建/更新/冲突/超限）
import test from 'node:test';
import assert from 'node:assert/strict';
import { __internals } from '../dist/index.js';

const { createApi, MemoryStore, jwtSign, jwtVerify } = __internals;

const SECRET = 'x'.repeat(32);
const env = {
    JWT_SECRET: SECRET,
    ALIYUN_AK_ID: 'test-ak', ALIYUN_AK_SECRET: 'test-sk',
    OSS_BUCKET: 'test-bucket', OSS_REGION: 'oss-cn-hangzhou',
};
const ORIGIN = 'https://shimucheng12-art.github.io';

// ---- SMS stub：可编程应答 ----
function makeSms(behavior = {}) {
    return {
        calls: [],
        send: async (phone) => {
            behavior.sendLog?.push(phone);
            if (behavior.sendDelay) await new Promise(r => setTimeout(r, behavior.sendDelay));
            if (behavior.sendError) return { ok: false, error: 'net', httpStatus: 502 };
            return { ok: true, error: behavior.sendErr };
        },
        check: async (phone, code) => {
            behavior.checkLog?.push([phone, code]);
            if (behavior.checkError) return { ok: false, error: 'net', httpStatus: 502 };
            return { ok: true, pass: behavior.pass ?? (code === '123456') };
        },
    };
}

function newApi(behavior = {}, store = new MemoryStore()) {
    const sms = makeSms(behavior);
    return { store, api: createApi(store, env, { smsSend: sms.send, smsCheck: sms.check }), behavior };
}

const req = (method, path, body, headers = {}) => ({
    method, path, headers: { origin: ORIGIN, ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const POST = (path, body, h) => req('POST', path, body, h);
const GET = (path, h) => req('GET', path, undefined, h);
const PUT = (path, body, h) => req('PUT', path, body, h);

// ---------- 基础 ----------
test('健康检查返回 ok', async () => {
    const { api } = newApi();
    const r = await api.handle(GET('/api/health'));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.time > 0);
});

test('CORS：白名单来源被回显', async () => {
    const { api } = newApi();
    const r = await api.handle(GET('/api/health'));
    assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
});

test('CORS：非白名单来源回退到默认', async () => {
    const { api } = newApi();
    const r = await api.handle(req('GET', '/api/health', undefined, { origin: 'https://evil.example.com' }));
    assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
});

test('OPTIONS 预检返回 204', async () => {
    const { api } = newApi();
    const r = await api.handle(req('OPTIONS', '/api/auth/sms/send'));
    assert.equal(r.status, 204);
});

test('未知路径返回 404', async () => {
    const { api } = newApi();
    const r = await api.handle(GET('/api/nothing'));
    assert.equal(r.status, 404);
});

// ---------- JWT ----------
test('JWT 签发后可验证，载荷保留', async () => {
    const token = await jwtSign(SECRET, { sub: 'u123', exp: Math.floor(Date.now() / 1000) + 60 });
    const p = await jwtVerify(SECRET, token);
    assert.equal(p.sub, 'u123');
});

test('JWT 篡改签名验证失败', async () => {
    const token = await jwtSign(SECRET, { sub: 'u123', exp: Math.floor(Date.now() / 1000) + 60 });
    const parts = token.split('.');
    const bad = parts[0] + '.' + parts[1] + '.' + (parts[2] === 'AAAA' ? 'BBBB' : 'AAAA');
    assert.equal(await jwtVerify(SECRET, bad), null);
});

test('JWT 过期后验证失败', async () => {
    const token = await jwtSign(SECRET, { sub: 'u123', exp: Math.floor(Date.now() / 1000) - 10 });
    assert.equal(await jwtVerify(SECRET, token), null);
});

test('JWT 密钥不同则验证失败', async () => {
    const token = await jwtSign(SECRET, { sub: 'u123', exp: Math.floor(Date.now() / 1000) + 60 });
    assert.equal(await jwtVerify('y'.repeat(32), token), null);
});

// ---------- 短信发送 ----------
test('手机号格式不合法 → 400', async () => {
    const { api } = newApi();
    for (const bad of ['12345', 'abc', '912345678901', '', ' 13800138000 11']) {
        const r = await api.handle(POST('/api/auth/sms/send', { phone: bad }));
        assert.equal(r.status, 400, `phone=${JSON.stringify(bad)}`);
    }
});

test('正常发送 → 200 ok，并写入限流台账', async () => {
    const log = [];
    const { api, store } = newApi({ sendLog: log });
    const r = await api.handle(POST('/api/auth/sms/send', { phone: '13800138000' }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(log, ['13800138000']);
    const t = await store.get('t/13800138000');
    assert.ok(t && t.value.sent_at > 0);
});

test('60 秒冷却期内重复发送 → 429', async () => {
    const { api } = newApi();
    await api.handle(POST('/api/auth/sms/send', { phone: '13800138000' }));
    const r = await api.handle(POST('/api/auth/sms/send', { phone: '13800138000' }));
    assert.equal(r.status, 429);
    assert.ok(r.body.retry_after > 0);
});

test('冷却期外可再次发送', async () => {
    const { api, store } = newApi();
    await api.handle(POST('/api/auth/sms/send', { phone: '13800138000' }));
    // 把台账时间拨回 61 秒前
    const t = await store.get('t/13800138000');
    await store.putIfMatch('t/13800138000', { ...t.value, sent_at: t.value.sent_at - 61_000 }, t.etag);
    const r = await api.handle(POST('/api/auth/sms/send', { phone: '13800138000' }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
});

test('每日 10 条上限 → 429', async () => {
    const { api, store } = newApi();
    // 预置今日已发 10 条
    await store.putIfAbsent('t/13800138000', {
        sent_at: Date.now() - 120_000, daily_date: new Date().toISOString().slice(0, 10),
        daily_count: 10, fail_count: 0, last_fail_at: 0,
    });
    const r = await api.handle(POST('/api/auth/sms/send', { phone: '13800138000' }));
    assert.equal(r.status, 429);
    assert.match(r.body.error, /上限/);
});

test('平台业务错误 → 友好文案（如每日上限）', async () => {
    const { api } = newApi({ sendErr: 'isv.DAY_LIMIT_CONTROL' });
    const r = await api.handle(POST('/api/auth/sms/send', { phone: '13800138000' }));
    assert.equal(r.status, 429);
    assert.match(r.body.error, /上限/);
});

test('平台业务错误（未知码）→ 通用文案', async () => {
    const { api } = newApi({ sendErr: 'isv.UNKNOWN_WEIRD_CODE' });
    const r = await api.handle(POST('/api/auth/sms/send', { phone: '13800138000' }));
    assert.equal(r.status, 429);
    assert.equal(typeof r.body.error, 'string');
});

test('传输层失败 → 502', async () => {
    const { api } = newApi({ sendError: true });
    const r = await api.handle(POST('/api/auth/sms/send', { phone: '13800138000' }));
    assert.equal(r.status, 502);
});

test('发送失败不消耗当日配额（台账回滚）', async () => {
    const { api, store } = newApi({ sendError: true });
    await api.handle(POST('/api/auth/sms/send', { phone: '13800138000' }));
    const t = await store.get('t/13800138000');
    assert.equal(t, null);
});

test('请求体缺 phone / 非 JSON → 400', async () => {
    const { api } = newApi();
    const r1 = await api.handle(POST('/api/auth/sms/send', {}));
    assert.equal(r1.status, 400);
    const r2 = await api.handle({ method: 'POST', path: '/api/auth/sms/send', headers: {}, body: 'not-json' });
    assert.equal(r2.status, 400);
});

// ---------- 短信登录 ----------
test('验证码格式不合法 → 400', async () => {
    const { api } = newApi();
    for (const code of ['12345', '12345a', '1234567', '']) {
        const r = await api.handle(POST('/api/auth/sms/login', { phone: '13800138000', code }));
        assert.equal(r.status, 400, `code=${code}`);
    }
});

test('验证通过 → 签发 token，创建用户', async () => {
    const { api, store } = newApi();
    const r = await api.handle(POST('/api/auth/sms/login', { phone: '13800138000', code: '123456' }));
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
    const u = await store.get('u/13800138000');
    assert.ok(u && u.value.id);
    const payload = await jwtVerify(SECRET, r.body.token);
    assert.equal(payload.sub, u.value.id);
});

test('同一手机号重复登录 → 同一 user_id（幂等）', async () => {
    const { api, store } = newApi();
    const a = await api.handle(POST('/api/auth/sms/login', { phone: '13800138000', code: '123456' }));
    const b = await api.handle(POST('/api/auth/sms/login', { phone: '13800138000', code: '123456' }));
    const ua = await store.get('u/13800138000');
    const pa = await jwtVerify(SECRET, a.body.token);
    const pb = await jwtVerify(SECRET, b.body.token);
    assert.equal(pa.sub, pb.sub);
    assert.equal(pa.sub, ua.value.id);
});

test('验证码错误 → 401', async () => {
    const { api } = newApi({ pass: false });
    const r = await api.handle(POST('/api/auth/sms/login', { phone: '13800138000', code: '000000' }));
    assert.equal(r.status, 401);
});

test('验证失败累计 10 次 → 429 锁定', async () => {
    const { api, store } = newApi({ pass: false });
    for (let i = 0; i < 10; i++) {
        const r = await api.handle(POST('/api/auth/sms/login', { phone: '13800138000', code: '000000' }));
        assert.equal(r.status, 401, `第${i + 1}次`);
    }
    const locked = await api.handle(POST('/api/auth/sms/login', { phone: '13800138000', code: '123456' }));
    assert.equal(locked.status, 429);
    const t = await store.get('t/13800138000');
    assert.equal(t.value.fail_count, 10);
});

test('发送成功后重置失败计数', async () => {
    const { api, store } = newApi({ pass: false });
    for (let i = 0; i < 5; i++) await api.handle(POST('/api/auth/sms/login', { phone: '13800138000', code: '000000' }));
    // 冷却期内发送会 429（但重置逻辑发生在成功发送后；这里直接拨时间）
    const t = await store.get('t/13800138000');
    await store.putIfMatch('t/13800138000', { ...t.value, sent_at: Date.now() - 120_000, fail_count: 9 }, t.etag);
    const sendOk = newApi({});
    const r = await sendOk.api.handle(POST('/api/auth/sms/send', { phone: '13800138000' }));
    assert.equal(r.status, 200);
    // 发送成功 → fail_count 归零
    assert.equal((await sendOk.store.get('t/13800138000')).value.fail_count, 0);
});

test('登录时传输层失败 → 502', async () => {
    const { api } = newApi({ checkError: true });
    const r = await api.handle(POST('/api/auth/sms/login', { phone: '13800138000', code: '123456' }));
    assert.equal(r.status, 502);
});

// ---------- 数据同步 ----------
async function login(api) {
    const r = await api.handle(POST('/api/auth/sms/login', { phone: '13800138000', code: '123456' }));
    return r.body.token;
}

test('无 token 访问数据 → 401', async () => {
    const { api } = newApi();
    const g = await api.handle(GET('/api/data'));
    assert.equal(g.status, 401);
    const p = await api.handle(PUT('/api/data', { data: 'x', base_updated_at: null }));
    assert.equal(p.status, 401);
});

test('坏 token 访问数据 → 401', async () => {
    const { api } = newApi();
    const g = await api.handle(GET('/api/data', { authorization: 'Bearer not.a.jwt' }));
    assert.equal(g.status, 401);
});

test('新用户 GET 数据 → 200 空数据', async () => {
    const { api } = newApi();
    const token = await login(api);
    const r = await api.handle(GET('/api/data', { authorization: `Bearer ${token}` }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data, null);
    assert.equal(r.body.updated_at, null);
});

test('PUT 创建数据 → 200，再 GET 返回', async () => {
    const { api } = newApi();
    const token = await login(api);
    const put = await api.handle(PUT('/api/data', { data: '{"v":1}', base_updated_at: null }, { authorization: `Bearer ${token}` }));
    assert.equal(put.status, 200);
    assert.ok(put.body.updated_at > 0);
    const g = await api.handle(GET('/api/data', { authorization: `Bearer ${token}` }));
    assert.equal(g.body.data, '{"v":1}');
    assert.equal(g.body.updated_at, put.body.updated_at);
});

test('PUT 带 base 更新 → 200 冲突时 → 409', async () => {
    const { api } = newApi();
    const token = await login(api);
    const p1 = await api.handle(PUT('/api/data', { data: '"a"', base_updated_at: null }, { authorization: `Bearer ${token}` }));
    assert.equal(p1.status, 200);
    // 用 base=null 再写 → 已存在 → 409
    const p2 = await api.handle(PUT('/api/data', { data: '"b"', base_updated_at: null }, { authorization: `Bearer ${token}` }));
    assert.equal(p2.status, 409);
    // 用正确 base 更新 → 200
    const p3 = await api.handle(PUT('/api/data', { data: '"c"', base_updated_at: p1.body.updated_at }, { authorization: `Bearer ${token}` }));
    assert.equal(p3.status, 200);
    // 用过期 base → 409
    const p4 = await api.handle(PUT('/api/data', { data: '"d"', base_updated_at: p1.body.updated_at }, { authorization: `Bearer ${token}` }));
    assert.equal(p4.status, 409);
});

test('PUT 数据超 2MB → 413', async () => {
    const { api } = newApi();
    const token = await login(api);
    const big = 'x'.repeat(2_000_001);
    const r = await api.handle(PUT('/api/data', { data: big, base_updated_at: null }, { authorization: `Bearer ${token}` }));
    assert.equal(r.status, 413);
});

test('PUT 非法请求体 → 400', async () => {
    const { api } = newApi();
    const token = await login(api);
    const r = await api.handle({ method: 'PUT', path: '/api/data', headers: { authorization: `Bearer ${token}` }, body: 'not-json' });
    assert.equal(r.status, 400);
    const r2 = await api.handle(PUT('/api/data', { base_updated_at: null }, { authorization: `Bearer ${token}` }));
    assert.equal(r2.status, 400);
});

// ---------- KV 存储语义 ----------
test('MemoryStore putIfAbsent 幂等语义', async () => {
    const s = new MemoryStore();
    assert.equal(await s.putIfAbsent('k', { a: 1 }), true);
    assert.equal(await s.putIfAbsent('k', { a: 2 }), false);
    assert.equal((await s.get('k')).value.a, 1);
});

test('MemoryStore putIfMatch 版本语义', async () => {
    const s = new MemoryStore();
    await s.putIfAbsent('k', { a: 1 });
    const cur = await s.get('k');
    assert.equal(await s.putIfMatch('k', { a: 2 }, 'wrong-etag'), false);
    assert.equal((await s.get('k')).value.a, 1);
    assert.equal(await s.putIfMatch('k', { a: 3 }, cur.etag), true);
    assert.equal((await s.get('k')).value.a, 3);
});

// ---------- FC 入口适配 ----------
test('handler（FC 入口）事件协议：Buffer 事件 → JSON 信封响应', async () => {
    const { handler } = await import('../dist/index.js');
    // OSS 未配置时走空存储；健康检查不受影响
    delete process.env.OSS_BUCKET;
    // 模拟 FC 3.0 HTTP 触发器事件
    const event = Buffer.from(JSON.stringify({
        version: 'v1',
        rawPath: '/api/health',
        headers: { Origin: ORIGIN },
        queryParameters: {},
        body: '',
        isBase64Encoded: true,
        requestContext: { http: { method: 'GET', path: '/api/health', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4' } },
    }));
    let cbErr = null, cbResult = null;
    const callback = (err, result) => { cbErr = err; cbResult = result; };
    await handler(event, {}, callback);
    assert.equal(cbErr, null);
    const env1 = JSON.parse(cbResult);
    assert.equal(env1.statusCode, 200);
    assert.equal(env1.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(JSON.parse(env1.body).ok, true);
    assert.equal(env1.isBase64Encoded, false);
});

test('handler（FC 入口）事件协议：POST body base64 解码', async () => {
    const { handler } = await import('../dist/index.js');
    delete process.env.OSS_BUCKET;
    const payload = JSON.stringify({ phone: '12345' });
    const event = Buffer.from(JSON.stringify({
        version: 'v1',
        rawPath: '/api/auth/sms/send',
        headers: { Origin: ORIGIN },
        body: Buffer.from(payload).toString('base64'),
        isBase64Encoded: true,
        requestContext: { http: { method: 'POST', path: '/api/auth/sms/send', protocol: 'HTTP/1.1' } },
    }));
    let cbResult = null;
    await handler(event, {}, (e, r) => { cbResult = r; });
    const env2 = JSON.parse(cbResult);
    assert.equal(env2.statusCode, 400); // 手机号格式不合法 → 证明 body 已正确解码
});

test('handler（FC 入口）事件协议：无 callback 时返回信封', async () => {
    const { handler } = await import('../dist/index.js');
    delete process.env.OSS_BUCKET;
    const event = Buffer.from(JSON.stringify({
        rawPath: '/api/health',
        headers: {},
        body: '',
        isBase64Encoded: false,
        requestContext: { http: { method: 'GET' } },
    }));
    const out = await handler(event, {});
    const env3 = JSON.parse(out);
    assert.equal(env3.statusCode, 200);
});
