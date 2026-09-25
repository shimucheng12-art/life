// logic/params.ts — 药代动力学参数表
// 数值来源：上游 PKSharedCatalog.json（E2 家族与 T 家族均为官方锚定拟合值，MIT）。
// EU / CPA 为本仓库重建时的近似补充（原实现已丢失），参数已按文献量级校准。

import { Ester, ExtraKey, PKCustomParams, GEL_SITE_ORDER, GelSiteKey, SublingualTierParams } from './types';

// ---------- E2 核心参数 ----------
export const CorePK = {
    vdPerKG: 2.0,          // L/kg 表观分布容积
    kClear: 0.41,          // 游离 E2 口服/舌下/凝胶路径终末清除 h⁻¹
    kClearInjection: 0.041,// 注射路径终末清除 h⁻¹
    depotK1Corr: 1.0,
};

// ---------- E2 酯信息 ----------
export const EsterInfo: Record<string, { name: string, mw: number }> = {
    [Ester.E2]: { name: "Estradiol", mw: 272.38 },
    [Ester.EB]: { name: "Estradiol Benzoate", mw: 376.50 },
    [Ester.EV]: { name: "Estradiol Valerate", mw: 356.50 },
    [Ester.EC]: { name: "Estradiol Cypionate", mw: 396.58 },
    [Ester.EN]: { name: "Estradiol Enanthate", mw: 384.56 },
    // EU（十一酸雌二醇）：重建近似，取十一酸酯分子量
    [Ester.EU]: { name: "Estradiol Undecylate", mw: 441.60 },
    [Ester.CPA]: { name: "Cyproterone Acetate", mw: 416.98 },
    [Ester.T]: { name: "Testosterone", mw: 288.42 },
    [Ester.TC]: { name: "Testosterone Cypionate", mw: 412.61 },
    [Ester.TE]: { name: "Testosterone Enanthate", mw: 400.59 },
    [Ester.TU]: { name: "Testosterone Undecanoate", mw: 456.71 },
};

/** 酯 → E2 换算系数（E2 质量分数）。未知酯返回 1.0，保证调用方安全。 */
export function getToE2Factor(ester: Ester): number {
    if (ester === Ester.E2) return 1.0;
    const info = EsterInfo[ester as string];
    if (!info) return 1.0;
    return EsterInfo[Ester.E2].mw / info.mw;
}

/** 酯 → T 换算系数（T 质量分数）。 */
export function getToTFactor(ester: Ester): number {
    if (ester === Ester.T) return 1.0;
    const info = EsterInfo[ester as string];
    if (!info) return 1.0;
    return EsterInfo[Ester.T].mw / info.mw;
}

// ---------- 注射双库吸收（E2 家族） ----------
export const TwoPartDepotPK = {
    Frac_fast: {
        [Ester.EB]: 0.90, [Ester.EV]: 0.40, [Ester.EC]: 0.229164549,
        [Ester.EN]: 0.05, [Ester.E2]: 1.0,
        // EU：超长效，几乎全部走慢库（重建近似）
        [Ester.EU]: 0.04,
    } as Record<string, number>,
    k1_fast: {
        [Ester.EB]: 0.144, [Ester.EV]: 0.0216, [Ester.EC]: 0.005035046,
        [Ester.EN]: 0.0010, [Ester.E2]: 0,
        [Ester.EU]: 0.0008,
    } as Record<string, number>,
    k1_slow: {
        [Ester.EB]: 0.114, [Ester.EV]: 0.0138, [Ester.EC]: 0.004510574,
        [Ester.EN]: 0.0050, [Ester.E2]: 0,
        [Ester.EU]: 0.0025,
    } as Record<string, number>,
};

/** E2 注射形成分数（进入 E2 曲线的比例） */
export const InjectionPK = {
    formationFraction: {
        [Ester.EB]: 0.10922376473734707,
        [Ester.EV]: 0.062258288229969413,
        [Ester.EC]: 0.117255838,
        [Ester.EN]: 0.12,
        [Ester.EU]: 0.12,       // 重建近似（参照 EN）
        [Ester.E2]: 1.0,
    } as Record<string, number>,
};

/** 酯水解速率（k2） */
export const EsterPK = {
    k2: {
        [Ester.EB]: 0.090, [Ester.EV]: 0.070, [Ester.EC]: 0.045, [Ester.EN]: 0.015,
        [Ester.EU]: 0.012,      // 重建近似
        [Ester.E2]: 0,
    } as Record<string, number>,
};

// ---------- 口服 ----------
export const OralPK = {
    kAbsE2: 0.32,   // 口服 E2 吸收（锚定后值）
    kAbsEV: 0.05,   // 口服 EV 吸收
    bioavailability: 0.03, // 口服 E2/EV 生物利用度
};

// ---------- 睾酮核心 ----------
export const TCorePK = {
    vdPerKG: 2.0,
    kClear: 0.6,           // T 凝胶路径终末清除 h⁻¹
    kClearInjection: 0.03, // T 注射路径终末清除 h⁻¹
    gelK1: 0.05534590723252352,
    gelFmax: 0.22613930825011333,
};

export const TDepotPK = {
    Frac_fast: { [Ester.TC]: 0.35, [Ester.TE]: 0.35, [Ester.TU]: 0.3 } as Record<string, number>,
    k1_fast: { [Ester.TC]: 0.016, [Ester.TE]: 0.022, [Ester.TU]: 0.005 } as Record<string, number>,
    k1_slow: { [Ester.TC]: 0.0018, [Ester.TE]: 0.0035, [Ester.TU]: 0.001127743154530867 } as Record<string, number>,
    formationFraction: {
        [Ester.TC]: 0.06775603562678995,
        [Ester.TE]: 0.09963018136697789,
        [Ester.TU]: 0.12940928580278235,
        [Ester.T]: 1.0,
    } as Record<string, number>,
    hydrolysisK2: { [Ester.TC]: 0.06, [Ester.TE]: 0.12, [Ester.TU]: 0.015, [Ester.T]: 0 } as Record<string, number>,
};

// ---------- CPA（重建近似：口服单室 Bateman，单位 ng/mL） ----------
export const CPAPK = {
    kAbs: 0.6,        // 吸收 h⁻¹
    kClear: 0.017,    // ≈ 41 h 终末半衰期
    bioavailability: 0.75,
    vdPerKG: 6.0,     // 表观分布容积 L/kg（校准至 12.5 mg/d ≈ 50 ng/mL 稳态）
};

// ---------- 凝胶 ----------
export const GelPK = {
    k1: 0.022,  // E2 凝胶吸收
    // 部位生物利用度默认值（可被 PKCustomParams 覆盖）
    siteF: { arm: 0.05, thigh: 0.03, scrotal: 0.25 } as Record<GelSiteKey, number>,
};

export function gelSiteKeyFromExtras(extras: Partial<Record<ExtraKey, number>>): GelSiteKey {
    const idx = Math.round(extras[ExtraKey.gelSite] ?? 0);
    return GEL_SITE_ORDER[Math.min(Math.max(idx, 0), GEL_SITE_ORDER.length - 1)];
}

// ---------- 默认可调参数（PKParams 页面所见即此） ----------
export const DEFAULT_PK_PARAMS: PKCustomParams = {
    e2_ff_EB: 0.1092,
    e2_ff_EV: 0.0623,
    e2_ff_EC: 0.1173,
    e2_ff_EN: 0.12,
    e2_ff_EU: 0.12,
    e2_oral_bio: 0.03,
    e2_sl_quick: 0.01,
    e2_sl_casual: 0.04,
    e2_sl_standard: 0.11,
    e2_sl_strict: 0.18,
    e2_gel_arm: 0.05,
    e2_gel_thigh: 0.03,
    e2_gel_scrotal: 0.25,
    e2_kClear: 0.41,
    e2_kClearInj: 0.041,
    t_ff_TC: 0.0678,
    t_ff_TE: 0.0996,
    t_ff_TU: 0.1294,
    t_gel_F: 0.2261,
    t_kClear: 0.6,
    t_kClearInj: 0.03,
};

/** θ 档位 → 数值（尊重用户自定义参数） */
export function thetaForTier(extras: Partial<Record<ExtraKey, number>>, custom?: PKCustomParams | null): number {
    if (extras[ExtraKey.sublingualTheta] !== undefined) {
        return Math.max(0, Math.min(1, extras[ExtraKey.sublingualTheta] as number));
    }
    const tierIdx = Math.round(extras[ExtraKey.sublingualTier] ?? 2);
    const tierKey = (["quick", "casual", "standard", "strict"] as const)[tierIdx] || "standard";
    if (custom) {
        const map: Record<string, number> = {
            quick: custom.e2_sl_quick,
            casual: custom.e2_sl_casual,
            standard: custom.e2_sl_standard,
            strict: custom.e2_sl_strict,
        };
        return map[tierKey] ?? SublingualTierParams[tierKey].theta;
    }
    return SublingualTierParams[tierKey].theta;
}
