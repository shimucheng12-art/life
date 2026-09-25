// logic/engine.ts — 模拟引擎：三室/双库/双通路/贴片零阶解析解 + 多分析物时间网格
// 解析式与上游 HRT-Recorder-online/logic.ts 保持一致（MIT）。

import {
    Route, Ester, ExtraKey, DoseEvent, SimulationResult, PKCustomParams, HRTMode,
    E2_ESTERS, T_ESTERS, SL_TIER_ORDER,
} from './types';
import {
    CorePK, EsterInfo, TwoPartDepotPK, InjectionPK, EsterPK, OralPK,
    TCorePK, TDepotPK, CPAPK, GelPK, getToE2Factor, getToTFactor,
    gelSiteKeyFromExtras, thetaForTier,
} from './params';

interface ResolvedParams {
    Frac_fast: number;
    k1_fast: number;
    k1_slow: number;
    k2: number;        // 酯水解
    k3: number;        // 游离清除
    F: number;         // 进入中心室的总量系数
    F_fast: number;
    F_slow: number;
    rateMGh: number;   // 贴片零阶速率
}

/** 三室解析解：吸收 k1 → 水解 k2 → 清除 k3
 *  与上游 HRT-Recorder-online/logic.ts 的 _analytic3C 完全一致（MIT）。
 *  标准链式三室解：A(t) = D·F·k1·k2·(t1+t2+t3)，t=0 时恒为 0，曲线平滑上升。
 *  （旧实现系数错位，会在给药瞬间产生 a+b+c≈5 倍剂量的虚假尖峰。） */
function _analytic3C(tau: number, dose: number, F: number, k1: number, k2: number, k3: number): number {
    if (tau <= 0 || dose <= 0 || k1 <= 0 || k2 <= 0) return 0;
    const k1_k2 = k1 - k2;
    const k1_k3 = k1 - k3;
    const k2_k3 = k2 - k3;
    // 奇异保护：任意两个速率过于接近时退化为安全值
    if (Math.abs(k1_k2) < 1e-9 || Math.abs(k1_k3) < 1e-9 || Math.abs(k2_k3) < 1e-9) return 0;
    const term1 = Math.exp(-k1 * tau) / (k1_k2 * k1_k3);
    const term2 = Math.exp(-k2 * tau) / (-k1_k2 * k2_k3);
    const term3 = Math.exp(-k3 * tau) / (k1_k3 * k2_k3);
    return dose * F * k1 * k2 * (term1 + term2 + term3);
}

/** 单室 Bateman */
function _bateman(tau: number, dose: number, F: number, ka: number, ke: number): number {
    if (tau <= 0 || dose <= 0) return 0;
    if (Math.abs(ka - ke) < 1e-9) return dose * F * ka * tau * Math.exp(-ke * tau);
    return dose * F * ka / (ka - ke) * (Math.exp(-ke * tau) - Math.exp(-ka * tau));
}

class PrecomputedEventModel {
    model: (timeH: number) => number;

    constructor(private event: DoseEvent, private allEvents: DoseEvent[], private custom: PKCustomParams | null) {
        this.model = this.build();
    }

    private build(): (timeH: number) => number {
        const event = this.event;
        const startTime = event.timeH;
        const pk = this.custom;
        const isT = T_ESTERS.has(event.ester);
        const isE2Family = E2_ESTERS.has(event.ester);

        if (event.route === Route.injection) {
            // ---- 注射：双库 ----
            const k3 = isT
                ? (pk?.t_kClearInj ?? TCorePK.kClearInjection)
                : CorePK.kClearInjection;

            let Frac_fast: number, k1_fast: number, k1_slow: number, k2: number, form: number;
            if (isT) {
                const ffMap: Record<string, number> = {
                    [Ester.TC]: pk?.t_ff_TC ?? TDepotPK.formationFraction[Ester.TC],
                    [Ester.TE]: pk?.t_ff_TE ?? TDepotPK.formationFraction[Ester.TE],
                    [Ester.TU]: pk?.t_ff_TU ?? TDepotPK.formationFraction[Ester.TU],
                    [Ester.T]: 1.0,
                };
                Frac_fast = TDepotPK.Frac_fast[event.ester as string] ?? 0.3;
                k1_fast = TDepotPK.k1_fast[event.ester as string] ?? 0.01;
                k1_slow = TDepotPK.k1_slow[event.ester as string] ?? 0.002;
                k2 = TDepotPK.hydrolysisK2[event.ester as string] ?? 0.05;
                form = ffMap[event.ester as string] ?? 1.0;
            } else {
                const ffMap: Record<string, number> = {
                    [Ester.EB]: pk?.e2_ff_EB ?? InjectionPK.formationFraction[Ester.EB],
                    [Ester.EV]: pk?.e2_ff_EV ?? InjectionPK.formationFraction[Ester.EV],
                    [Ester.EC]: pk?.e2_ff_EC ?? InjectionPK.formationFraction[Ester.EC],
                    [Ester.EN]: pk?.e2_ff_EN ?? InjectionPK.formationFraction[Ester.EN],
                    [Ester.EU]: pk?.e2_ff_EU ?? InjectionPK.formationFraction[Ester.EU],
                    [Ester.E2]: 1.0,
                };
                Frac_fast = TwoPartDepotPK.Frac_fast[event.ester as string] ?? 0.5;
                k1_fast = TwoPartDepotPK.k1_fast[event.ester as string] ?? 0.01;
                k1_slow = TwoPartDepotPK.k1_slow[event.ester as string] ?? 0.01;
                k2 = EsterPK.k2[event.ester as string] ?? 0.05;
                form = ffMap[event.ester as string] ?? 1.0;
            }

            const toFactor = isT ? getToTFactor(event.ester) : getToE2Factor(event.ester);
            // 与上游一致：F = form × toFactor（E2 家族事件剂量按 E2 等效计）
            const F = form * toFactor;
            const dose = event.doseMG;
            const doseF = dose * F * Frac_fast;
            const doseS = dose * F * (1 - Frac_fast);
            const p = { k1_fast, k1_slow, k2, k3, F_fast: 1, F_slow: 1, Frac_fast, rateMGh: 0 };

            return (timeH: number) => {
                const tau = timeH - startTime;
                if (tau <= 0) return 0;
                const injAmount = (tau: number, d: number, k1: number) =>
                    _analytic3C(tau, d, 1, k1, k2, k3);
                return injAmount(tau, doseF, p.k1_fast) + injAmount(tau, doseS, p.k1_slow);
            };
        }

        if (event.route === Route.gel) {
            // ---- 凝胶：单室 Bateman，F 取部位值 ----
            const k1 = isT ? TCorePK.gelK1 : GelPK.k1;
            let F: number;
            if (isT) {
                F = pk?.t_gel_F ?? TCorePK.gelFmax;
            } else {
                const site = gelSiteKeyFromExtras(event.extras);
                const map: Record<string, number> = {
                    arm: pk?.e2_gel_arm ?? GelPK.siteF.arm,
                    thigh: pk?.e2_gel_thigh ?? GelPK.siteF.thigh,
                    scrotal: pk?.e2_gel_scrotal ?? GelPK.siteF.scrotal,
                };
                F = map[site] ?? GelPK.siteF.arm;
            }
            const k3 = isT ? (pk?.t_kClear ?? TCorePK.kClear) : (pk?.e2_kClear ?? CorePK.kClear);
            const ka = (event.extras[ExtraKey.areaCM2] ?? 0) > 0 ? k1 * (event.extras[ExtraKey.areaCM2] as number) : k1;
            return (timeH: number) => _bateman(timeH - startTime, event.doseMG, F, ka, k3);
        }

        if (event.route === Route.oral) {
            // ---- 口服 ----
            if (event.ester === Ester.CPA) {
                // CPA 走独立曲线（mg → ng/mL）
                return (timeH: number) => _bateman(timeH - startTime, event.doseMG, CPAPK.bioavailability, CPAPK.kAbs, CPAPK.kClear);
            }
            const k1 = event.ester === Ester.EV ? OralPK.kAbsEV : OralPK.kAbsE2;
            const F = pk?.e2_oral_bio ?? OralPK.bioavailability;
            const k2Value = event.ester === Ester.EV ? (EsterPK.k2[Ester.EV] || 0) : 0;
            const k3 = pk?.e2_kClear ?? CorePK.kClear;
            return (timeH: number) => {
                const tau = timeH - startTime;
                if (tau <= 0) return 0;
                if (k2Value > 0) {
                    return _analytic3C(tau, event.doseMG, F, k1, k2Value, k3);
                }
                return _bateman(tau, event.doseMG, F, k1, k3);
            };
        }

        if (event.route === Route.sublingual) {
            // ---- 舌下双通路：快=黏膜，慢=吞咽口服 ----
            const theta = thetaForTier(event.extras, pk);
            const kAbsSL = 1.8;
            const FSlow = pk?.e2_oral_bio ?? OralPK.bioavailability;
            const k3 = pk?.e2_kClear ?? CorePK.kClear;
            const dose = event.doseMG;
            const doseF = dose * theta;
            const doseS = dose * (1 - theta);
            const k1Slow = event.ester === Ester.EV ? OralPK.kAbsEV : OralPK.kAbsE2;
            const k2Value = event.ester === Ester.EV ? (EsterPK.k2[Ester.EV] || 0) : 0;

            return (timeH: number) => {
                const tau = timeH - startTime;
                if (tau <= 0) return 0;
                // 快通路：一室（E2）或三室（EV，需水解）
                const fastAmount = k2Value > 0
                    ? _analytic3C(tau, doseF, 1, kAbsSL, k2Value, k3)
                    : _bateman(tau, doseF, 1, kAbsSL, k3);
                // 慢通路：吞咽 → 口服
                const slowAmount = _bateman(tau, doseS, FSlow, k1Slow, k3);
                return fastAmount + slowAmount;
            };
        }

        if (event.route === Route.patchApply) {
            // ---- 贴片：零阶输入，移除事件决定佩戴窗口 ----
            const remove = this.allEvents.find(
                e => e.route === Route.patchRemove && e.timeH > startTime && e.id !== event.id
            );
            const wearH = (remove?.timeH ?? Number.MAX_VALUE) - startTime;
            const releaseRate = event.extras[ExtraKey.releaseRateUGPerDay] ?? 0;
            const rateMGh = (releaseRate / 24) / 1000; // µg/day → mg/h
            const k3 = pk?.e2_kClear ?? CorePK.kClear;

            return (timeH: number) => {
                const tau = timeH - startTime;
                if (tau <= 0) return 0;
                if (rateMGh > 0) {
                    if (tau <= wearH) {
                        return rateMGh / k3 * (1 - Math.exp(-k3 * tau));
                    }
                    const amtAtRemoval = rateMGh / k3 * (1 - Math.exp(-k3 * wearH));
                    return amtAtRemoval * Math.exp(-k3 * (tau - wearH));
                }
                // 一阶“假库”旧版：佩戴内按 Bateman 吸收，移除后以佩戴末量按 k3 衰减（吸收截断）
                const F = pk?.e2_gel_arm ?? GelPK.siteF.arm; // 贴片经皮 F 与手臂凝胶同源
                const k1 = 0.0075; // patchFallbackK1
                if (tau <= wearH) {
                    return _bateman(tau, event.doseMG, F, k1, k3);
                }
                const atRemoval = _bateman(wearH, event.doseMG, F, k1, k3);
                return atRemoval * Math.exp(-k3 * (tau - wearH));
            };
        }

        // patchRemove 与未知路由：不产生浓度
        return () => 0;
    }
}

export interface SimulateOptions {
    isTransmasc?: boolean;
    pkParams?: PKCustomParams | null;
    fromTimeH?: number;
    toTimeH?: number;
    stepH?: number;
}

/** 运行仿真：E2 / CPA / T 三条曲线共用时间网格 */
export function runSimulation(events: DoseEvent[], weight: number, options: SimulateOptions = {}): SimulationResult {
    const { isTransmasc = false, pkParams = null, stepH = 0.5 } = options;
    const usable = events.filter(e => e.route !== Route.patchRemove);
    if (!usable.length) {
        return { timeH: [], concPGmL_E2: [], concPGmL_CPA: [], concNGdL_T: [], auc: 0 };
    }

    const nowH = Date.now() / 3600000;
    const minT = Math.min(...usable.map(e => e.timeH)) - 24;
    const maxEventT = Math.max(...usable.map(e => e.timeH));
    const fromTimeH = options.fromTimeH ?? minT;
    const toTimeH = options.toTimeH ?? Math.max(maxEventT + 24 * 14, nowH + 24);

    // 网格上限保护（约 2 年 @0.5h ≈ 3.5 万点）
    const totalPoints = Math.min(Math.floor((toTimeH - fromTimeH) / stepH) + 1, 40000);
    const actualStep = (toTimeH - fromTimeH) / (totalPoints - 1);
    const timeH: number[] = new Array(totalPoints);
    for (let i = 0; i < totalPoints; i++) timeH[i] = fromTimeH + i * actualStep;

    const e2Events = usable.filter(e => E2_ESTERS.has(e.ester));
    const cpaEvents = usable.filter(e => e.ester === Ester.CPA);
    const tEvents = usable.filter(e => T_ESTERS.has(e.ester));

    const plasmaML = Math.max(1, CorePK.vdPerKG * weight * 1000);       // E2
    const cpaPlasmaML = Math.max(1, CPAPK.vdPerKG * weight * 1000);     // CPA
    const tPlasmaML = Math.max(1, TCorePK.vdPerKG * weight * 1000);     // T

    const computeTrack = (evts: DoseEvent[], volumeML: number, scale: number) => {
        const models = evts.map(e => new PrecomputedEventModel(e, events, pkParams));
        const out = new Array<number>(totalPoints).fill(0);
        for (let i = 0; i < totalPoints; i++) {
            let amount = 0;
            for (const m of models) amount += m.model(timeH[i]);
            // mg → 目标浓度：pg/mL ×1e9/mL；ng/mL ×1e6/mL；ng/dL ×1e8/100mL
            out[i] = (amount * scale) / volumeML;
        }
        return out;
    };

    const concPGmL_E2 = e2Events.length ? computeTrack(e2Events, plasmaML, 1e9) : new Array<number>(totalPoints).fill(0);
    const concPGmL_CPA = cpaEvents.length ? computeTrack(cpaEvents, cpaPlasmaML, 1e6) : new Array<number>(totalPoints).fill(0);
    const concNGdL_T = (tEvents.length || isTransmasc)
        ? computeTrack(tEvents.length ? tEvents : [], tPlasmaML, 1e8)
        : new Array<number>(totalPoints).fill(0);

    // AUC（E2 曲线，梯形法）
    let auc = 0;
    for (let i = 1; i < totalPoints; i++) {
        auc += (concPGmL_E2[i] + concPGmL_E2[i - 1]) / 2 * (timeH[i] - timeH[i - 1]);
    }

    return { timeH, concPGmL_E2, concPGmL_CPA, concNGdL_T, auc };
}

// ---------- 插值 ----------
function _interp(timeH: number[], values: number[], hour: number): number | null {
    if (!timeH.length) return null;
    if (hour <= timeH[0]) return values[0];
    if (hour >= timeH[timeH.length - 1]) return values[values.length - 1];
    let low = 0, high = timeH.length - 1;
    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (timeH[mid] === hour) return values[mid];
        if (timeH[mid] < hour) low = mid;
        else high = mid;
    }
    const t0 = timeH[low], t1 = timeH[high];
    const c0 = values[low], c1 = values[high];
    if (t1 === t0) return c0;
    return c0 + (c1 - c0) * (hour - t0) / (t1 - t0);
}

/** 通用插值（默认 E2 曲线；track 可选 'E2' | 'CPA' | 'T'） */
export function interpolateConcentration(sim: SimulationResult, hour: number, track: 'E2' | 'CPA' | 'T' = 'E2'): number | null {
    const values = track === 'E2' ? sim.concPGmL_E2 : track === 'CPA' ? sim.concPGmL_CPA : sim.concNGdL_T;
    return _interp(sim.timeH, values, hour);
}

export function interpolateConcentration_E2(sim: SimulationResult, hour: number): number | null {
    return _interp(sim.timeH, sim.concPGmL_E2, hour);
}

export function interpolateConcentration_CPA(sim: SimulationResult, hour: number): number | null {
    return _interp(sim.timeH, sim.concPGmL_CPA, hour);
}

export function interpolateConcentration_T(sim: SimulationResult, hour: number): number | null {
    return _interp(sim.timeH, sim.concNGdL_T, hour);
}

// ---------- 生物利用度展示口径 ----------
/** UI“生物有效剂量”倍率：注射=form×toFactor；凝胶/舌下=对应 F；口服=F */
export function getBioavailabilityMultiplier(route: Route, ester: Ester, extras: Partial<Record<ExtraKey, number>>, custom: PKCustomParams | null = null): number {
    const isT = T_ESTERS.has(ester);
    switch (route) {
        case Route.injection: {
            if (isT) {
                const ffMap: Record<string, number> = {
                    [Ester.TC]: custom?.t_ff_TC ?? TDepotPK.formationFraction[Ester.TC],
                    [Ester.TE]: custom?.t_ff_TE ?? TDepotPK.formationFraction[Ester.TE],
                    [Ester.TU]: custom?.t_ff_TU ?? TDepotPK.formationFraction[Ester.TU],
                    [Ester.T]: 1.0,
                };
                return (ffMap[ester as string] ?? 1) * getToTFactor(ester);
            }
            const ffMap: Record<string, number> = {
                [Ester.EB]: custom?.e2_ff_EB ?? InjectionPK.formationFraction[Ester.EB],
                [Ester.EV]: custom?.e2_ff_EV ?? InjectionPK.formationFraction[Ester.EV],
                [Ester.EC]: custom?.e2_ff_EC ?? InjectionPK.formationFraction[Ester.EC],
                [Ester.EN]: custom?.e2_ff_EN ?? InjectionPK.formationFraction[Ester.EN],
                [Ester.EU]: custom?.e2_ff_EU ?? InjectionPK.formationFraction[Ester.EU],
                [Ester.E2]: 1.0,
            };
            return (ffMap[ester as string] ?? 1) * getToE2Factor(ester);
        }
        case Route.gel: {
            if (isT) return custom?.t_gel_F ?? TCorePK.gelFmax;
            const site = gelSiteKeyFromExtras(extras);
            const map: Record<string, number> = {
                arm: custom?.e2_gel_arm ?? GelPK.siteF.arm,
                thigh: custom?.e2_gel_thigh ?? GelPK.siteF.thigh,
                scrotal: custom?.e2_gel_scrotal ?? GelPK.siteF.scrotal,
            };
            return map[site] ?? GelPK.siteF.arm;
        }
        case Route.sublingual:
            return thetaForTier(extras, custom);
        case Route.oral:
        case Route.patchApply:
            return ester === Ester.CPA ? CPAPK.bioavailability : (custom?.e2_oral_bio ?? OralPK.bioavailability);
        default:
            return 0;
    }
}

// 注：SL_TIER_ORDER 的导出以 logic/types.ts 为准（此处仅内部使用），避免 index.ts 重名冲突。
