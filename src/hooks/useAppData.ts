// src/hooks/useAppData.ts — 应用数据中枢：双模式事件/化验存储、模拟、校准、导入导出
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
    DoseEvent, LabResult, SimulationResult, PKCustomParams, HRTMode, Route,
    runSimulation, createCalibrationInterpolator,
    interpolateConcentration_E2, interpolateConcentration_CPA, interpolateConcentration_T,
} from '../../logic';
import { DoseTemplate } from '../components/DoseFormModal';
import { QuickDose } from '../components/dose_form/QuickDoseButtons';
import { useHRTMode } from '../contexts/HRTModeContext';
import { useTranslation } from '../contexts/LanguageContext';

const LS_EVENTS = 'app-events-v2';
const LS_LABS = 'app-labs-v2';
const LS_WEIGHT = 'app-weight';
const LS_TEMPLATES = 'app-templates';
const LS_QUICK = 'app-quick-doses';
const LS_PK = 'app-pk-params';

type ModeData<T> = { transfem: T[]; transmasc: T[] };

function loadJSON<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function saveJSON(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch { /* 配额或隐私模式失败时静默 */ }
}

export interface ExportPayload {
    meta: { version: 2; exportedAt: string };
    weight: number;
    doseTemplates?: DoseTemplate[];
    quickDoses?: QuickDose[];
    pkParams?: PKCustomParams | null;
    modes: {
        transfem: { events: DoseEvent[]; labResults: LabResult[] };
        transmasc: { events: DoseEvent[]; labResults: LabResult[] };
    };
}

interface StatusStyle {
    label: string;
    color: string;
    bg: string;
    border: string;
}

function statusStyleFor(levelKey: string, t: (k: string) => string): StatusStyle {
    switch (levelKey) {
        case 'verylow': return { label: t('status.level.verylow'), color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/20', border: 'border-blue-200 dark:border-blue-900' };
        case 'low': return { label: t('status.level.low'), color: 'text-cyan-600 dark:text-cyan-400', bg: 'bg-cyan-50 dark:bg-cyan-900/20', border: 'border-cyan-200 dark:border-cyan-900' };
        case 'high': return { label: t('status.level.high'), color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-200 dark:border-amber-900' };
        case 'veryhigh': return { label: t('status.level.veryhigh'), color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20', border: 'border-red-200 dark:border-red-900' };
        default: return { label: t('status.level.normal'), color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-200 dark:border-emerald-900' };
    }
}

function e2LevelKey(pgml: number): string {
    if (pgml < 100) return 'verylow';
    if (pgml < 200) return 'low';
    if (pgml <= 600) return 'normal';
    if (pgml <= 900) return 'high';
    return 'veryhigh';
}

function tLevelKey(ngdl: number): string {
    if (ngdl < 320) return 'low';
    if (ngdl <= 1000) return 'normal';
    return 'high';
}

export function useAppData(showDialog: (type: string, message: string, onConfirm?: () => void) => void) {
    const { mode, isTransmasc } = useHRTMode();
    const { t } = useTranslation();

    // ---- 持久化状态 ----
    const [eventsByMode, setEventsByMode] = useState<ModeData<DoseEvent>>(() => loadJSON<ModeData<DoseEvent>>(LS_EVENTS, { transfem: [], transmasc: [] }));
    const [labByMode, setLabByMode] = useState<ModeData<LabResult>>(() => loadJSON<ModeData<LabResult>>(LS_LABS, { transfem: [], transmasc: [] }));
    const [weight, setWeight] = useState<number>(() => loadJSON<number>(LS_WEIGHT, 65));
    const [doseTemplates, setDoseTemplates] = useState<DoseTemplate[]>(() => loadJSON<DoseTemplate[]>(LS_TEMPLATES, []));
    const [quickDoses, setQuickDoses] = useState<QuickDose[]>(() => loadJSON<QuickDose[]>(LS_QUICK, []));
    const [pkParams, setPkParams] = useState<PKCustomParams | null>(() => loadJSON<PKCustomParams | null>(LS_PK, null));

    useEffect(() => { saveJSON(LS_EVENTS, eventsByMode); }, [eventsByMode]);
    useEffect(() => { saveJSON(LS_LABS, labByMode); }, [labByMode]);
    useEffect(() => { saveJSON(LS_WEIGHT, weight); }, [weight]);
    useEffect(() => { saveJSON(LS_TEMPLATES, doseTemplates); }, [doseTemplates]);
    useEffect(() => { saveJSON(LS_QUICK, quickDoses); }, [quickDoses]);
    useEffect(() => { saveJSON(LS_PK, pkParams); }, [pkParams]);

    // ---- 当前模式数据 ----
    const events = eventsByMode[mode] ?? [];
    const labResults = labByMode[mode] ?? [];

    const setEvents = useCallback((updater: DoseEvent[] | ((prev: DoseEvent[]) => DoseEvent[])) => {
        setEventsByMode(prev => {
            const cur = prev[mode] ?? [];
            const next = typeof updater === 'function' ? (updater as Function)(cur) : updater;
            return { ...prev, [mode]: next };
        });
    }, [mode]);

    const setLabResults = useCallback((updater: LabResult[] | ((prev: LabResult[]) => LabResult[])) => {
        setLabByMode(prev => {
            const cur = prev[mode] ?? [];
            const next = typeof updater === 'function' ? (updater as Function)(cur) : updater;
            return { ...prev, [mode]: next };
        });
    }, [mode]);

    // ---- 模拟 ----
    const simulation = useMemo<SimulationResult | null>(() => {
        if (!events.length && !labResults.length) return null;
        return runSimulation(events, weight, { isTransmasc, pkParams });
    }, [events, weight, isTransmasc, pkParams]);

    // ---- 当前时间（分钟级刷新） ----
    const [currentTime, setCurrentTime] = useState<Date>(() => new Date());
    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 60_000);
        return () => clearInterval(timer);
    }, []);

    // ---- 校准 ----
    const calibrationFn = useMemo(() => {
        if (!simulation) return (_t: number) => 1;
        return createCalibrationInterpolator(labResults, simulation, isTransmasc);
    }, [simulation, labResults, isTransmasc]);

    const nowH = currentTime.getTime() / 3600000;
    const currentLevel = useMemo(() => {
        if (!simulation) return 0;
        const v = interpolateConcentration_E2(simulation, nowH);
        return v == null ? 0 : v * calibrationFn(nowH);
    }, [simulation, calibrationFn, nowH]);

    const currentCPA = useMemo(() => {
        if (!simulation) return 0;
        const v = interpolateConcentration_CPA(simulation, nowH);
        return v == null ? 0 : v;
    }, [simulation, nowH]);

    const currentT = useMemo(() => {
        if (!simulation) return 0;
        const v = interpolateConcentration_T(simulation, nowH);
        return v == null ? 0 : v * (isTransmasc ? calibrationFn(nowH) : 1);
    }, [simulation, calibrationFn, nowH, isTransmasc]);

    const currentStatus = useMemo<StatusStyle | null>(() => {
        if (!simulation || !events.length) return null;
        if (isTransmasc) {
            if (currentT <= 0) return null;
            return statusStyleFor(tLevelKey(currentT), t);
        }
        if (currentLevel <= 0) return null;
        return statusStyleFor(e2LevelKey(currentLevel), t);
    }, [simulation, events.length, currentLevel, currentT, isTransmasc, t]);

    // ---- 事件分组（按本地日期，倒序） ----
    const groupedEvents = useMemo<Record<string, DoseEvent[]>>(() => {
        const groups: Record<string, DoseEvent[]> = {};
        for (const e of events) {
            const d = new Date(e.timeH * 3600000);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            (groups[key] ??= []).push(e);
        }
        for (const k of Object.keys(groups)) {
            groups[k].sort((a, b) => b.timeH - a.timeH);
        }
        const sortedKeys = Object.keys(groups).sort((a, b) => (a < b ? 1 : -1));
        const out: Record<string, DoseEvent[]> = {};
        for (const k of sortedKeys) out[k] = groups[k];
        return out;
    }, [events]);

    // ---- CRUD ----
    const addEvent = useCallback((e: DoseEvent) => {
        setEvents(prev => [...prev, e]);
    }, [setEvents]);

    const updateEvent = useCallback((e: DoseEvent) => {
        setEvents(prev => prev.map(x => x.id === e.id ? e : x));
    }, [setEvents]);

    const deleteEvent = useCallback((id: string) => {
        setEvents(prev => prev.filter(x => x.id !== id));
    }, [setEvents]);

    const clearAllEvents = useCallback(() => {
        setEventsByMode(prev => ({ ...prev, [mode]: [] }));
    }, [mode]);

    const addLabResult = useCallback((r: LabResult) => {
        setLabResults(prev => [...prev, r]);
    }, [setLabResults]);

    const updateLabResult = useCallback((r: LabResult) => {
        setLabResults(prev => prev.map(x => x.id === r.id ? r : x));
    }, [setLabResults]);

    const deleteLabResult = useCallback((id: string) => {
        setLabResults(prev => prev.filter(x => x.id !== id));
    }, [setLabResults]);

    const clearLabResults = useCallback(() => {
        setLabByMode(prev => ({ ...prev, [mode]: [] }));
    }, [mode]);

    const addTemplate = useCallback((tpl: DoseTemplate) => {
        setDoseTemplates(prev => (prev.some(x => x.id === tpl.id) ? prev : [...prev, tpl]));
    }, []);

    const deleteTemplate = useCallback((id: string) => {
        setDoseTemplates(prev => prev.filter(x => x.id !== id));
    }, []);

    const addQuickDose = useCallback((d: QuickDose) => {
        setQuickDoses(prev => (prev.some(x => x.id === d.id) ? prev : [...prev, d]));
    }, []);

    const deleteQuickDose = useCallback((id: string) => {
        setQuickDoses(prev => prev.filter(x => x.id !== id));
    }, []);

    const clearPkParams = useCallback(() => setPkParams(null), []);
    const resetPkParams = useCallback(() => setPkParams(null), []);

    // ---- 导入 / 合并 / 导出 ----
    const processImportedData = useCallback((parsed: any): boolean => {
        try {
            let newEvents: ModeData<DoseEvent[]> = { transfem: [], transmasc: [] };
            let newLabs: ModeData<LabResult[]> = { transfem: [], transmasc: [] };
            let newWeight: number | undefined;
            let newTemplates: DoseTemplate[] | undefined;
            let newQuick: QuickDose[] | undefined;
            let newPk: PKCustomParams | null = null;

            const sanitizeEvents = (arr: any[]): DoseEvent[] => (Array.isArray(arr) ? arr.filter(e => e && typeof e.timeH === 'number' && e.route && e.ester !== undefined) : []);
            const sanitizeLabs = (arr: any[]): LabResult[] => (Array.isArray(arr) ? arr.filter(l => l && typeof l.timeH === 'number') : []);

            if (parsed?.modes) {
                newEvents.transfem = sanitizeEvents(parsed.modes.transfem?.events);
                newEvents.transmasc = sanitizeEvents(parsed.modes.transmasc?.events);
                newLabs.transfem = sanitizeLabs(parsed.modes.transfem?.labResults);
                newLabs.transmasc = sanitizeLabs(parsed.modes.transmasc?.labResults);
            } else if (Array.isArray(parsed?.events) || Array.isArray(parsed?.labResults)) {
                // 旧版扁平格式：按化验单位归入对应模式
                const evts = sanitizeEvents(parsed.events);
                const labs = sanitizeLabs(parsed.labResults);
                const hasT = evts.some((e: DoseEvent) => String(e.ester).startsWith('T') || String(e.ester) === 'TC' || String(e.ester) === 'TE' || String(e.ester) === 'TU');
                const target: HRTMode = hasT ? 'transmasc' : 'transfem';
                newEvents[target] = evts;
                newLabs[target] = labs;
            } else {
                return false;
            }

            if (typeof parsed?.weight === 'number' && parsed.weight > 0) newWeight = parsed.weight;
            if (Array.isArray(parsed?.doseTemplates)) newTemplates = parsed.doseTemplates.filter((x: any) => x && x.id);
            if (Array.isArray(parsed?.quickDoses)) newQuick = parsed.quickDoses.filter((x: any) => x && x.id);
            if (parsed?.pkParams && typeof parsed.pkParams === 'object') newPk = parsed.pkParams;

            // 导入 = 覆盖当前本地数据
            setEventsByMode(newEvents);
            setLabByMode(newLabs);
            if (newWeight !== undefined) setWeight(newWeight);
            if (newTemplates) setDoseTemplates(newTemplates);
            if (newQuick) setQuickDoses(newQuick);
            setPkParams(newPk);
            return true;
        } catch (e) {
            console.error('import failed', e);
            return false;
        }
    }, []);

    const mergeImportedData = useCallback((parsed: any) => {
        try {
            const incomingEvents = parsed?.modes
                ? { transfem: parsed.modes.transfem?.events ?? [], transmasc: parsed.modes.transmasc?.events ?? [] }
                : { transfem: parsed?.events ?? [], transmasc: [] };
            const incomingLabs = parsed?.modes
                ? { transfem: parsed.modes.transfem?.labResults ?? [], transmasc: parsed.modes.transmasc?.labResults ?? [] }
                : { transfem: parsed?.labResults ?? [], transmasc: [] };

            setEventsByMode(prev => ({
                transfem: dedupeById([...(prev.transfem ?? []), ...incomingEvents.transfem]),
                transmasc: dedupeById([...(prev.transmasc ?? []), ...incomingEvents.transmasc]),
            }));
            setLabByMode(prev => ({
                transfem: dedupeById([...(prev.transfem ?? []), ...incomingLabs.transfem]),
                transmasc: dedupeById([...(prev.transmasc ?? []), ...incomingLabs.transmasc]),
            }));
            if (Array.isArray(parsed?.doseTemplates)) {
                setDoseTemplates(prev => dedupeById([...prev, ...parsed.doseTemplates]));
            }
            if (typeof parsed?.weight === 'number' && parsed.weight > 0) {
                setWeight(parsed.weight);
            }
        } catch (e) {
            console.error('merge failed', e);
        }
    }, []);

    const buildExportPayload = useCallback((): ExportPayload => ({
        meta: { version: 2, exportedAt: new Date().toISOString() },
        weight,
        doseTemplates,
        quickDoses,
        pkParams,
        modes: {
            transfem: { events: eventsByMode.transfem ?? [], labResults: labByMode.transfem ?? [] },
            transmasc: { events: eventsByMode.transmasc ?? [], labResults: labByMode.transmasc ?? [] },
        },
    }), [weight, doseTemplates, quickDoses, pkParams, eventsByMode, labByMode]);

    return {
        events, setEvents,
        weight, setWeight,
        labResults, setLabResults,
        doseTemplates, setDoseTemplates,
        simulation,
        currentTime,
        calibrationFn,
        currentLevel,
        currentCPA,
        currentT,
        currentStatus,
        groupedEvents,
        addEvent, updateEvent, deleteEvent, clearAllEvents,
        addLabResult, updateLabResult, deleteLabResult, clearLabResults,
        addTemplate, deleteTemplate,
        addQuickDose, deleteQuickDose,
        quickDoses,
        pkParams, setPkParams, clearPkParams, resetPkParams,
        processImportedData,
        mergeImportedData,
        buildExportPayload,
    };
}

function dedupeById<T extends { id: string }>(arr: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of arr) {
        if (item?.id && !seen.has(item.id)) {
            seen.add(item.id);
            out.push(item);
        }
    }
    return out;
}

export default useAppData;
