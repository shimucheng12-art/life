// logic/calibration.ts — 化验校准插值器
// 用化验值 / 模型预测值 的比值，构建分段线性校正系数函数。

import { LabResult, SimulationResult } from './types';
import { interpolateConcentration_E2, interpolateConcentration_T } from './engine';
import { convertToPgMl, convertToNgDl, isT_LabUnit } from './units';

/**
 * 创建校准函数。无有效化验点时返回恒等 1。
 * @param labResults 化验记录
 * @param sim 模拟结果
 * @param isTransmasc 睾酮模式（用 T 曲线校准），否则用 E2 曲线
 */
export function createCalibrationInterpolator(
    labResults: LabResult[],
    sim: SimulationResult,
    isTransmasc: boolean = false,
): (timeH: number) => number {
    const points: { t: number, ratio: number }[] = [];
    for (const lab of labResults) {
        if (!sim.timeH.length) break;
        const predicted = isTransmasc
            ? interpolateConcentration_T(sim, lab.timeH)
            : interpolateConcentration_E2(sim, lab.timeH);
        if (predicted == null || predicted <= 0 || !isFinite(predicted)) continue;
        const measured = isTransmasc
            ? (isT_LabUnit(lab.unit) ? convertToNgDl(lab.concValue, lab.unit) : 0)
            : (!isT_LabUnit(lab.unit) ? convertToPgMl(lab.concValue, lab.unit) : 0);
        if (measured <= 0) continue;
        const ratio = measured / predicted;
        if (isFinite(ratio) && ratio > 0) {
            points.push({ t: lab.timeH, ratio: Math.min(Math.max(ratio, 0.05), 20) });
        }
    }

    if (points.length < 1) return () => 1;
    points.sort((a, b) => a.t - b.t);

    return (timeH: number): number => {
        if (timeH <= points[0].t) return points[0].ratio;
        if (timeH >= points[points.length - 1].t) return points[points.length - 1].ratio;
        for (let i = 1; i < points.length; i++) {
            if (timeH <= points[i].t) {
                const a = points[i - 1], b = points[i];
                if (b.t === a.t) return b.ratio;
                const k = (timeH - a.t) / (b.t - a.t);
                return a.ratio + (b.ratio - a.ratio) * k;
            }
        }
        return points[points.length - 1].ratio;
    };
}
