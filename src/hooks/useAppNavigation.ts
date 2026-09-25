// src/hooks/useAppNavigation.ts — 视图路由与导航项
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Calendar, FlaskConical, Settings as SettingsIcon, UserCircle, ShieldCheck } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';

export type ViewKey =
    | 'home'
    | 'history'
    | 'lab'
    | 'settings'
    | 'settings-hrt-mode'
    | 'settings-language'
    | 'settings-appearance'
    | 'settings-weight'
    | 'settings-export'
    | 'settings-import'
    | 'account'
    | 'sessions'
    | 'two-factor'
    | 'pk-params'
    | 'admin';

export interface NavItem {
    id: string;
    label: string;
    icon: React.ElementType;
}

export function useAppNavigation(user: any) {
    const { t } = useTranslation();
    const { needsSetup2FA } = useAuth();
    const [currentView, setCurrentView] = useState<ViewKey>('home');
    const [transitionDirection, setTransitionDirection] = useState<'forward' | 'backward'>('forward');
    const mainScrollRef = useRef<HTMLDivElement>(null);

    const VIEW_ORDER: ViewKey[] = [
        'home', 'history', 'lab', 'settings', 'settings-hrt-mode', 'settings-language',
        'settings-appearance', 'settings-weight', 'settings-export', 'settings-import',
        'account', 'sessions', 'two-factor', 'pk-params', 'admin',
    ];

    const handleViewChange = useCallback((view: ViewKey | string) => {
        if (needsSetup2FA && view !== 'two-factor' && view !== 'account') return;
        setTransitionDirection((prev) => {
            const prevIdx = VIEW_ORDER.indexOf(currentView);
            const nextIdx = VIEW_ORDER.indexOf(view as ViewKey);
            if (prevIdx >= 0 && nextIdx >= 0) return nextIdx > prevIdx ? 'forward' : 'backward';
            return 'forward';
        });
        setCurrentView(view as ViewKey);
    }, [currentView, needsSetup2FA, VIEW_ORDER]);

    useEffect(() => {
        mainScrollRef.current?.scrollTo({ top: 0 });
    }, [currentView]);

    const navItems = useMemo<NavItem[]>(() => {
        const items: NavItem[] = [
            { id: 'home', label: t('nav.home'), icon: Activity },
            { id: 'history', label: t('nav.history'), icon: Calendar },
            { id: 'lab', label: t('nav.lab'), icon: FlaskConical },
            { id: 'settings', label: t('nav.settings'), icon: SettingsIcon },
        ];
        if (user) {
            items.push({ id: 'account', label: t('nav.account'), icon: UserCircle });
        }
        if (user?.isAdmin) {
            items.push({ id: 'admin', label: t('nav.admin'), icon: ShieldCheck });
        }
        return items;
    }, [t, user]);

    return {
        currentView,
        setCurrentView,
        transitionDirection,
        handleViewChange,
        mainScrollRef,
        navItems,
    };
}

export default useAppNavigation;
