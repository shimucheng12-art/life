// src/services/admin.ts — 管理员 API
import { BackupMeta } from './cloud';
export type { BackupMeta };

export interface AdminUser {
    id: string;
    username: string;
    email?: string | null;
    is_admin?: boolean;
    created_at: number;
    deleted?: boolean;
    backup_count?: number;
}

export interface PaginatedUsers {
    users: AdminUser[];
    total: number;
    page: number;
    page_size: number;
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

const qs = (params: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== '') s.set(k, String(v));
    });
    const str = s.toString();
    return str ? `?${str}` : '';
};

export const adminService = {
    async getUsers(token: string, search?: string, page = 1, pageSize = 20): Promise<PaginatedUsers> {
        const res = await request(`/api/admin/users${qs({ search, page, page_size: pageSize })}`, token);
        return parse<PaginatedUsers>(res);
    },

    async changeUserPassword(token: string, userId: string, newPassword: string): Promise<void> {
        const res = await request(`/api/admin/users/${encodeURIComponent(userId)}/password`, token, {
            method: 'POST',
            body: JSON.stringify({ password: newPassword }),
        });
        await parse<unknown>(res);
    },

    async changeUsername(token: string, userId: string, newUsername: string): Promise<void> {
        const res = await request(`/api/admin/users/${encodeURIComponent(userId)}/username`, token, {
            method: 'PUT',
            body: JSON.stringify({ username: newUsername }),
        });
        await parse<unknown>(res);
    },

    async resetAvatar(token: string, userId: string): Promise<void> {
        const res = await request(`/api/admin/users/${encodeURIComponent(userId)}/reset-avatar`, token, {
            method: 'POST',
        });
        await parse<unknown>(res);
    },

    async getUserBackups(token: string, userId: string): Promise<BackupMeta[]> {
        const res = await request(`/api/admin/users/${encodeURIComponent(userId)}/backups`, token);
        return parse<BackupMeta[]>(res);
    },

    async deleteBackup(token: string, userId: string, backupId: string): Promise<void> {
        const res = await request(`/api/admin/users/${encodeURIComponent(userId)}/backups/${encodeURIComponent(backupId)}`, token, {
            method: 'DELETE',
        });
        await parse<unknown>(res);
    },

    async purgeBackups(token: string, userId: string): Promise<void> {
        const res = await request(`/api/admin/users/${encodeURIComponent(userId)}/backups`, token, {
            method: 'DELETE',
        });
        await parse<unknown>(res);
    },

    async deleteUser(token: string, userId: string): Promise<void> {
        const res = await request(`/api/admin/users/${encodeURIComponent(userId)}`, token, {
            method: 'DELETE',
        });
        await parse<unknown>(res);
    },
};
