// src/services/auth.ts — 认证 / 2FA / Passkey / 会话 API + WebAuthn 序列化工具

export interface User {
    id: string;
    username: string;
    isAdmin?: boolean;
    is_admin?: boolean;
    avatarUrl?: string;
    createdAt?: number;
}

export interface AuthResponse {
    token: string;
    user: User;
    needsSetup2FA?: boolean;
}

export interface Session {
    id: string;
    created_at: number;
    last_used_at: number;
    device_info?: string;
    ip?: string;
    current?: boolean;
}

export interface Passkey {
    id: string;
    device_name?: string;
    created_at: number;
}

// ---------- WebAuthn 序列化 ----------
export function ab2b64url(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64url2ab(s: string): ArrayBuffer {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (b64.length % 4)) % 4;
    const bin = atob(b64 + '='.repeat(pad));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
}

/** PublicKeyCredential（登录断言）→ 纯 JSON 可传输对象 */
export function serializeAssertionCredential(credential: any): any {
    const response = credential.response;
    return {
        id: credential.id,
        rawId: ab2b64url(credential.rawId),
        type: credential.type,
        response: {
            authenticatorData: ab2b64url(response.authenticatorData),
            clientDataJSON: ab2b64url(response.clientDataJSON),
            signature: ab2b64url(response.signature),
            userHandle: response.userHandle ? ab2b64url(response.userHandle) : undefined,
        },
    };
}

/** PublicKeyCredential（注册证明）→ 纯 JSON 可传输对象 */
export function serializeAttestationCredential(credential: any): any {
    const response = credential.response;
    return {
        id: credential.id,
        rawId: ab2b64url(credential.rawId),
        type: credential.type,
        response: {
            attestationObject: ab2b64url(response.attestationObject),
            clientDataJSON: ab2b64url(response.clientDataJSON),
        },
    };
}

// ---------- HTTP ----------
async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(path, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });
}

async function parse<T>(res: Response): Promise<T> {
    if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        let body: any = null;
        try { body = await res.json(); } catch { /* ignore */ }
        if (body?.error) msg = body.error;
        const err = new Error(msg) as any;
        if (body?.needs2FA) err.needs2FA = true;
        if (body?.method) err.method = body.method;
        throw err;
    }
    return res.json() as Promise<T>;
}

const authHeaders = (token: string) => ({ 'Authorization': `Bearer ${token}` });

// ---------- 认证 ----------
export const authService = {
    async login(username: string, password: string, totpCode?: string, backupCode?: string): Promise<AuthResponse> {
        const res = await request('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password, totpCode, backupCode }),
        });
        return parse<AuthResponse>(res);
    },

    async register(username: string, password: string): Promise<AuthResponse> {
        const res = await request('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });
        return parse<AuthResponse>(res);
    },

    async get2FAStatus(token: string): Promise<{ enabled: boolean }> {
        const res = await request('/api/auth/2fa', { headers: authHeaders(token) });
        return parse<{ enabled: boolean }>(res);
    },

    async setup2FA(token: string): Promise<{ secret: string; uri: string }> {
        const res = await request('/api/auth/2fa/setup', {
            method: 'POST',
            headers: authHeaders(token),
        });
        return parse<{ secret: string; uri: string }>(res);
    },

    async enable2FA(token: string, secret: string, code: string): Promise<{ backupCodes: string[] }> {
        const res = await request('/api/auth/2fa/enable', {
            method: 'POST',
            headers: authHeaders(token),
            body: JSON.stringify({ secret, code }),
        });
        return parse<{ backupCodes: string[] }>(res);
    },

    async disable2FA(token: string, password: string, code?: string): Promise<void> {
        const res = await request('/api/auth/2fa/disable', {
            method: 'POST',
            headers: authHeaders(token),
            body: JSON.stringify({ password, code }),
        });
        await parse<unknown>(res);
    },

    async getBackupCodesStatus(token: string): Promise<{ remaining: number }> {
        const res = await request('/api/auth/2fa/backup-codes', { headers: authHeaders(token) });
        return parse<{ remaining: number }>(res);
    },

    async generateBackupCodes(token: string): Promise<{ codes: string[] }> {
        const res = await request('/api/auth/2fa/backup-codes', {
            method: 'POST',
            headers: authHeaders(token),
        });
        return parse<{ codes: string[] }>(res);
    },

    // ---------- Passkey ----------
    async listPasskeys(token: string): Promise<Passkey[]> {
        const res = await request('/api/auth/passkeys', { headers: authHeaders(token) });
        return parse<Passkey[]>(res);
    },

    async registerPasskeyOptions(token: string): Promise<any> {
        const res = await request('/api/auth/passkeys/register/options', {
            method: 'POST',
            headers: authHeaders(token),
        });
        return parse<any>(res);
    },

    async registerPasskey(token: string, challengeToken: string, credential: any, deviceName?: string): Promise<{ backupCodes?: string[] }> {
        const res = await request('/api/auth/passkeys/register', {
            method: 'POST',
            headers: authHeaders(token),
            body: JSON.stringify({ challengeToken, credential, deviceName }),
        });
        return parse<{ backupCodes?: string[] }>(res);
    },

    async deletePasskey(token: string, passkeyId: string): Promise<void> {
        const res = await request(`/api/auth/passkeys/${encodeURIComponent(passkeyId)}`, {
            method: 'DELETE',
            headers: authHeaders(token),
        });
        await parse<unknown>(res);
    },

    async passkeyAuthOptions(username?: string): Promise<any> {
        const res = await request('/api/auth/passkeys/auth/options', {
            method: 'POST',
            body: JSON.stringify({ username }),
        });
        return parse<any>(res);
    },

    async passkeyAuthVerify(challengeToken: string, assertion: any): Promise<AuthResponse> {
        const res = await request('/api/auth/passkeys/auth', {
            method: 'POST',
            body: JSON.stringify({ challengeToken, assertion }),
        });
        return parse<AuthResponse>(res);
    },

    // ---------- 会话 ----------
    async listSessions(token: string): Promise<Session[]> {
        const res = await request('/api/auth/sessions', { headers: authHeaders(token) });
        return parse<Session[]>(res);
    },

    async terminateSession(token: string, sessionId: string): Promise<void> {
        const res = await request(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE',
            headers: authHeaders(token),
        });
        await parse<unknown>(res);
    },

    async terminateOtherSessions(token: string): Promise<void> {
        const res = await request('/api/auth/sessions', {
            method: 'DELETE',
            headers: authHeaders(token),
        });
        await parse<unknown>(res);
    },

    // ---------- 账户 ----------
    async updateProfile(token: string, username: string): Promise<{ username: string }> {
        const res = await request('/api/user/profile', {
            method: 'PUT',
            headers: authHeaders(token),
            body: JSON.stringify({ username }),
        });
        return parse<{ username: string }>(res);
    },

    async changePassword(token: string, current: string, newPassword: string): Promise<void> {
        const res = await request('/api/user/password', {
            method: 'POST',
            headers: authHeaders(token),
            body: JSON.stringify({ current, newPassword }),
        });
        await parse<unknown>(res);
    },

    async deleteAccount(token: string, password: string): Promise<void> {
        const res = await request('/api/user/account', {
            method: 'DELETE',
            headers: authHeaders(token),
            body: JSON.stringify({ password }),
        });
        await parse<unknown>(res);
    },
};
