// src/services/cloud.ts — 云端备份 API
import { isCloudEncrypted } from '../../logic';

export interface BackupEntry {
    id: string;
    data: string;            // JSON 文本或加密信封（isCloudEncrypted 判断）
    created_at: number;      // unix 秒
}

export interface BackupMeta {
    id: string;
    created_at: number;      // unix 秒
    data_size: number;       // 字节
}

async function request(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    return fetch(path, {
        ...init,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });
}

async function parse<T>(res: Response): Promise<T> {
    if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try {
            const body = await res.json();
            if (body?.error) msg = body.error;
        } catch { /* ignore */ }
        throw new Error(msg);
    }
    return res.json() as Promise<T>;
}

export const cloudService = {
    /** 保存一份备份；data 为 JSON 文本或加密信封对象（字符串化入库）。 */
    async save(token: string, payload: unknown): Promise<BackupEntry> {
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const res = await request('/api/cloud/backups', token, {
            method: 'POST',
            body: JSON.stringify({ data }),
        });
        return parse<BackupEntry>(res);
    },

    /** 完整备份列表（含 data），最新在前。 */
    async load(token: string): Promise<BackupEntry[]> {
        const res = await request('/api/cloud/backups', token);
        const list = await parse<BackupEntry[]>(res);
        return list.sort((a, b) => b.created_at - a.created_at);
    },

    /** 备份元信息列表（不含 data）。 */
    async listMeta(token: string): Promise<BackupMeta[]> {
        const res = await request('/api/cloud/backups/meta', token);
        const list = await parse<BackupMeta[]>(res);
        return list.sort((a, b) => b.created_at - a.created_at);
    },

    /** 取单条备份。 */
    async loadOne(token: string, backupId: string): Promise<BackupEntry> {
        const res = await request(`/api/cloud/backups/${encodeURIComponent(backupId)}`, token);
        return parse<BackupEntry>(res);
    },

    /** 删除单条备份。 */
    async deleteBackup(token: string, backupId: string): Promise<void> {
        const res = await request(`/api/cloud/backups/${encodeURIComponent(backupId)}`, token, { method: 'DELETE' });
        await parse<unknown>(res);
    },
};

/** 备份内容是否已加密（供 UI 展示徽标）。 */
export function isBackupEncrypted(entry: { data: string }): boolean {
    try {
        const parsed = JSON.parse(entry.data);
        return isCloudEncrypted(parsed);
    } catch {
        return false;
    }
}
