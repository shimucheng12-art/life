// src/services/export.ts — CSV / PDF 导出
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { saveAs } from 'file-saver';
import { DoseEvent, LabResult, Route, Ester } from '../../logic';
import { Lang } from '../i18n/translations';

export interface ExportContext {
    events: DoseEvent[];
    labResults: LabResult[];
    weight: number;
    lang: Lang;
    t: (k: string) => string;
}

const esterLabel = (e: Ester): string => String(e);
const routeLabel = (r: Route, t: (k: string) => string): string => t(`route.${r}`) || String(r);

function fmtDateTime(timeH: number): string {
    const d = new Date(timeH * 3600000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(timeH: number): string {
    const d = new Date(timeH * 3600000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 生成 CSV 文本（事件 + 化验），调用方负责保存。 */
export function exportToCSV({ events, labResults, weight, lang, t }: ExportContext): string {
    const rows: string[][] = [];
    rows.push([t('export.type'), t('export.datetime'), t('export.route'), t('export.ester'), t('export.dose_mg'), t('export.unit_note')]);

    const sorted = [...events].sort((a, b) => a.timeH - b.timeH);
    for (const e of sorted) {
        rows.push([
            'dose',
            fmtDateTime(e.timeH),
            routeLabel(e.route, t),
            esterLabel(e.ester),
            String(e.doseMG ?? ''),
            '',
        ]);
    }
    for (const l of [...labResults].sort((a, b) => a.timeH - b.timeH)) {
        rows.push([
            'lab',
            fmtDateTime(l.timeH),
            '',
            '',
            String(l.concValue ?? ''),
            l.unit ?? '',
        ]);
    }

    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = rows.map(r => r.map(c => esc(c ?? '')).join(',')).join('\r\n');
    return `\uFEFF${csv}`;
}

/** 生成并下载 PDF 报告。 */
export function exportToPDF({ events, labResults, weight, lang, t }: ExportContext): void {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();

    const title = t('export.pdf_title') || 'HRT Record';
    doc.setFontSize(16);
    doc.text(title, 40, 46);

    doc.setFontSize(10);
    doc.text(`${t('export.weight') || 'Weight'}: ${weight} kg`, 40, 66);
    doc.text(`${t('export.generated') || 'Generated'}: ${new Date().toLocaleString()}`, 40, 80);

    // 事件表
    const doseRows = [...events].sort((a, b) => a.timeH - b.timeH).map(e => [
        fmtDate(e.timeH),
        fmtDateTime(e.timeH).split(' ')[1],
        routeLabel(e.route, t),
        esterLabel(e.ester),
        `${e.doseMG ?? ''}`,
    ]);

    autoTable(doc, {
        startY: 96,
        head: [[t('export.date') || 'Date', t('export.time') || 'Time', t('export.route') || 'Route', t('export.ester') || 'Ester', t('export.dose_mg') || 'Dose (mg)']],
        body: doseRows.length ? doseRows : [['-', '-', '-', '-', '-']],
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [233, 30, 140] },
        margin: { left: 40, right: 40 },
    });

    // 化验表
    if (labResults.length) {
        // @ts-ignore jspdf-autotable 动态注入的属性
        const lastY = (doc as any).lastAutoTable?.finalY ?? 110;
        autoTable(doc, {
            startY: lastY + 24,
            head: [[t('export.date') || 'Date', t('export.value') || 'Value', 'Unit']],
            body: [...labResults].sort((a, b) => a.timeH - b.timeH).map(l => [
                fmtDate(l.timeH), `${l.concValue ?? ''}`, l.unit ?? '',
            ]),
            styles: { fontSize: 8, cellPadding: 3 },
            headStyles: { fillColor: [124, 58, 237] },
            margin: { left: 40, right: 40 },
        });
    }

    const footer = t('export.pdf_disclaimer') || 'For personal record only; not medical advice.';
    doc.setFontSize(8);
    doc.text(footer, 40, doc.internal.pageSize.getHeight() - 28);
    doc.save(`hrt-record-${new Date().toISOString().split('T')[0]}.pdf`);
}

/** 直接下载 CSV（某些调用方使用）。 */
export function downloadCSV(csv: string): void {
    saveAs(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `hrt-record-${new Date().toISOString().split('T')[0]}.csv`);
}
