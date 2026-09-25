// logic/units.ts — 化验单位换算

import { Ester } from './types';

/** 任意单位 → pg/mL（E2） */
export function convertToPgMl(value: number, unit: string): number {
    switch (unit) {
        case 'pg/ml': return value;
        case 'pmol/l': return value * 0.2724; // pmol/L ÷ 3.671（E2 分子量 272.38）
        case 'ng/dl': return value * 10;     // ng/dL → pg/mL（×10）
        case 'nmol/l': return value * 272.4;
        default: return value;
    }
}

/** 任意单位 → ng/dL（T） */
export function convertToNgDl(value: number, unit: string): number {
    switch (unit) {
        case 'ng/dl': return value;
        case 'nmol/l': return value * 28.84; // nmol/L × 28.84（T 分子量 288.42）
        case 'pg/ml': return value / 10;
        case 'pmol/l': return value * 0.02884;
        default: return value;
    }
}

/** 该单位是否为睾酮口径（ng/dL / nmol/L） */
export function isT_LabUnit(unit: string): boolean {
    return unit === 'ng/dl' || unit === 'nmol/l';
}

/** 酯的完整名（带缓存） */
export function esterDisplayName(ester: Ester): string {
    const map: Record<string, string> = {
        E2: 'Estradiol', EB: 'Estradiol Benzoate', EV: 'Estradiol Valerate',
        EC: 'Estradiol Cypionate', EN: 'Estradiol Enanthate', EU: 'Estradiol Undecylate',
        CPA: 'Cyproterone Acetate', T: 'Testosterone', TC: 'Testosterone Cypionate',
        TE: 'Testosterone Enanthate', TU: 'Testosterone Undecanoate',
    };
    return map[ester as string] ?? String(ester);
}
