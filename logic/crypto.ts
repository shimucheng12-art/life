// logic/crypto.ts — 本地加密 / 云端 E2EE / 压缩
// 全部基于浏览器 WebCrypto；云端备份密钥由口令派生，服务器与管理员均无法解密。

// ---------- 基础工具 ----------
const te = new TextEncoder();
const td = new TextDecoder();

function b64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

function unb64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function ab2b64url(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64url2ab(s: string): ArrayBuffer {
    const norm = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
    const bin = atob(norm + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
}

function randomPassword(len = 16): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const rnd = crypto.getRandomValues(new Uint8Array(len));
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[rnd[i] % alphabet.length];
    return s;
}

async function deriveKey(password: string, salt: Uint8Array, iterations = 200_000): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

async function aesGcmEncrypt(plain: string, key: CryptoKey, iv: Uint8Array): Promise<string> {
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        key,
        te.encode(plain),
    );
    return b64(ct);
}

async function aesGcmDecrypt(dataB64: string, key: CryptoKey, iv: Uint8Array): Promise<string | null> {
    try {
        const pt = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv as unknown as BufferSource },
            key,
            unb64(dataB64) as unknown as BufferSource,
        );
        return td.decode(pt);
    } catch {
        return null;
    }
}

// ---------- 文件级加密（导出/导入 .json） ----------
export interface EncryptedFilePayload {
    encrypted: true;
    iv: string;   // base64
    salt: string; // base64
    data: string; // base64 ciphertext
}

/** 加密一段 JSON 文本。不提供口令时生成随机口令并随返回值交回（供 UI 展示一次）。 */
export async function encryptData(json: string, customPassword?: string): Promise<{ data: string, password: string }> {
    const password = customPassword || randomPassword(16);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const data = await aesGcmEncrypt(json, key, iv);
    const payload: EncryptedFilePayload = { encrypted: true, iv: b64(iv), salt: b64(salt), data };
    return { data: JSON.stringify(payload, null, 2), password };
}

/** 解密 encryptData 产物；口令错误或数据损坏返回 null。 */
export async function decryptData(text: string, password: string): Promise<string | null> {
    try {
        const parsed = JSON.parse(text) as EncryptedFilePayload;
        if (!parsed || parsed.encrypted !== true || !parsed.iv || !parsed.salt || !parsed.data) return null;
        const key = await deriveKey(password, unb64(parsed.salt));
        return await aesGcmDecrypt(parsed.data, key, unb64(parsed.iv));
    } catch {
        return null;
    }
}

// ---------- 压缩（导入 {c: base64} 格式） ----------
export async function decompressData(b64Str: string): Promise<string> {
    const bytes = unb64(b64Str);
    const DS = (globalThis as any).DecompressionStream;
    if (!DS) throw new Error('DecompressionStream unsupported');
    const stream = (new Blob([bytes as unknown as BlobPart]).stream() as any)
        .pipeThrough(new DS('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return td.decode(buf);
}

export async function compressData(text: string): Promise<string> {
    const CS = (globalThis as any).CompressionStream;
    if (!CS) throw new Error('CompressionStream unsupported');
    const stream = (new Blob([text]).stream() as any).pipeThrough(new CS('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return b64(buf);
}

// ---------- 云端备份 E2EE ----------
const CLOUD_KEY_ITER = 100_000;

/**
 * 由口令 + 用户 ID 派生云端加密密钥（hex 字符串，可直接存 localStorage）。
 * 服务器只见密文；改密码后旧备份自然失效（这正是设计意图）。
 */
export async function deriveCloudKey(password: string, userId: string): Promise<string> {
    const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: te.encode(`hrt-cloud:${userId}`) as unknown as BufferSource,
            iterations: CLOUD_KEY_ITER,
            hash: 'SHA-256',
        },
        base,
        256,
    );
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function cloudKeyMaterial(keyHex: string): Promise<CryptoKey> {
    const raw = new Uint8Array(keyHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
    return crypto.subtle.importKey('raw', raw as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export interface CloudEncryptedEnvelope {
    v: 1;
    e: true;
    iv: string;   // base64
    data: string; // base64
}

export function isCloudEncrypted(obj: any): boolean {
    return !!obj && typeof obj === 'object' && obj.e === true && typeof obj.iv === 'string' && typeof obj.data === 'string';
}

/** 用派生密钥加密备份 JSON 文本，返回可入库的信封对象。 */
export async function encryptCloudPayload(json: string, keyHex: string): Promise<CloudEncryptedEnvelope> {
    const key = await cloudKeyMaterial(keyHex);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await aesGcmEncrypt(json, key, iv);
    return { v: 1, e: true, iv: b64(iv), data };
}

/** 解密云端信封；失败返回 null（如换密码后的旧备份）。 */
export async function decryptCloudPayload(envelope: any, keyHex: string): Promise<string | null> {
    if (!isCloudEncrypted(envelope) || !/^[0-9a-f]{64}$/.test(keyHex)) return null;
    try {
        const key = await cloudKeyMaterial(keyHex);
        return await aesGcmDecrypt(envelope.data, key, unb64(envelope.iv));
    } catch {
        return null;
    }
}
