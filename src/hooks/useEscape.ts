// src/hooks/useEscape.ts — 弹窗按 Esc 关闭
import { useEffect } from 'react';

export function useEscape(onClose: () => void, isActive: boolean = true) {
    useEffect(() => {
        if (!isActive) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onClose, isActive]);
}

export default useEscape;
