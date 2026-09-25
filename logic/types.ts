// logic/types.ts — 基础类型与枚举
// 依据上游 HRT-Recorder-PKcomponent-Test / HRT-Recorder-online（MIT）重建，
// 并扩展 CPA / EU / 睾酮酯（TC/TE/TU）以适配本应用的双模式（transfem / transmasc）。

export enum Route {
    injection = "injection",
    patchApply = "patchApply",
    patchRemove = "patchRemove",
    gel = "gel",
    oral = "oral",
    sublingual = "sublingual",
}

export enum Ester {
    // 雌激素家族
    E2 = "E2",
    EB = "EB",
    EV = "EV",
    EC = "EC",
    EN = "EN",
    EU = "EU",
    // 抗雄（醋酸环丙孕酮，单独一条 CPA 曲线，单位 ng/mL）
    CPA = "CPA",
    // 睾酮家族
    T = "T",
    TC = "TC",
    TE = "TE",
    TU = "TU",
}

export enum ExtraKey {
    concentrationMGmL = "concentrationMGmL",
    areaCM2 = "areaCM2",
    releaseRateUGPerDay = "releaseRateUGPerDay",
    sublingualTheta = "sublingualTheta",
    sublingualTier = "sublingualTier",
    gelSite = "gelSite",
}

export interface DoseEvent {
    id: string;
    route: Route;
    timeH: number;            // 距 1970-01-01 的小时数
    doseMG: number;           // E2 家族：E2 等效 mg；T 家族：酯原始 mg；CPA：CPA mg
    ester: Ester;
    extras: Partial<Record<ExtraKey, number>>;
}

export interface LabResult {
    id: string;
    timeH: number;
    concValue: number;
    unit: 'pg/ml' | 'pmol/l' | 'ng/dl' | 'nmol/l';
}

export type HRTMode = 'transfem' | 'transmasc';

/** 睾酮酯集合 */
export const T_ESTERS: ReadonlySet<Ester> = new Set<Ester>([Ester.T, Ester.TC, Ester.TE, Ester.TU]);
/** 雌激素酯集合 */
export const E2_ESTERS: ReadonlySet<Ester> = new Set<Ester>([Ester.E2, Ester.EB, Ester.EV, Ester.EC, Ester.EN, Ester.EU]);

export function isTestosteroneEster(ester: Ester): boolean {
    return T_ESTERS.has(ester);
}

export interface SimulationResult {
    timeH: number[];
    /** E2 曲线（pg/mL） */
    concPGmL_E2: number[];
    /** CPA 曲线（ng/mL，沿袭历史字段名） */
    concPGmL_CPA: number[];
    /** 睾酮曲线（ng/dL），transmasc 模式下有值 */
    concNGdL_T: number[];
    /** 梯形法 AUC（pg/mL·h，E2 曲线） */
    auc?: number;
}

/** 舌下含服档位（确定性顺序：0..3） */
export const SL_TIER_ORDER = ["quick", "casual", "standard", "strict"] as const;
export type SLTierKey = typeof SL_TIER_ORDER[number];

export interface SublingualTierParams {
    theta: number;
    hold: number; // 建议含服分钟数
}

export const SublingualTierParams: Record<SLTierKey, SublingualTierParams> = {
    quick: { theta: 0.01, hold: 2 },
    casual: { theta: 0.04, hold: 5 },
    standard: { theta: 0.11, hold: 10 },
    strict: { theta: 0.18, hold: 15 },
};

/** 凝胶涂抹部位（索引与 UI 一致） */
export const GEL_SITE_ORDER = ["arm", "thigh", "scrotal"] as const;
export type GelSiteKey = typeof GEL_SITE_ORDER[number];

/** 用户可调 PK 参数（PKParams 页面字段一一对应） */
export interface PKCustomParams {
    // E2 注射形成分数
    e2_ff_EB: number;
    e2_ff_EV: number;
    e2_ff_EC: number;
    e2_ff_EN: number;
    e2_ff_EU: number;
    // E2 口服生物利用度
    e2_oral_bio: number;
    // 舌下 θ 档位
    e2_sl_quick: number;
    e2_sl_casual: number;
    e2_sl_standard: number;
    e2_sl_strict: number;
    // 凝胶部位生物利用度
    e2_gel_arm: number;
    e2_gel_thigh: number;
    e2_gel_scrotal: number;
    // E2 清除
    e2_kClear: number;
    e2_kClearInj: number;
    // 睾酮
    t_ff_TC: number;
    t_ff_TE: number;
    t_ff_TU: number;
    t_gel_F: number;
    t_kClear: number;
    t_kClearInj: number;
}
