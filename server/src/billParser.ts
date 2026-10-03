import type { ParsedBillLine } from './types';

const TOTAL_LABEL = /\b(grand\s+total|net\s+payable|amount\s+payable|total\s+amount|bill\s+total|total)\b/i;
const SKIP_LABEL = /\b(sub\s*total|paid|advance|deposit|balance|discount|gst\s*no|invoice\s*no|bill\s*no|phone|date|uhid|ip\s*no)\b/i;
const AMOUNT_AT_END = /^(.*?[A-Za-z][^\d]*?)[\s:.\-|]*(?:₹|inr|rs\.?)?\s*([0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?:\.[0-9]{1,2})?\s*(?:\/-)?\s*$/i;

export interface ParsedBill {
  total_inr: number;
  lines: ParsedBillLine[];
  reconciled: boolean;
}

// Deterministic reader for itemized bills (text PDFs, TXT, or OCR output). The customer confirms the result.
export function parseBillText(text: string): ParsedBill | null {
  const lines: ParsedBillLine[] = [];
  let statedTotal: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || /^\[Page \d+\]$/.test(line)) continue;
    const match = AMOUNT_AT_END.exec(line);
    if (!match) continue;
    const label = match[1]!.replace(/[\s:.\-|]+$/, '').trim();
    const amount = Number(match[2]!.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) continue;
    if (TOTAL_LABEL.test(label) && !/sub\s*total/i.test(label)) {
      statedTotal = amount;
      continue;
    }
    if (SKIP_LABEL.test(label) || label.length < 3) continue;
    lines.push({ line: lines.length + 1, description: label.slice(0, 80), amount_inr: Math.round(amount) });
  }

  const lineTotal = lines.reduce((sum, line) => sum + line.amount_inr, 0);
  const total = statedTotal ?? lineTotal;
  if (!total) return null;
  return { total_inr: Math.round(total), lines, reconciled: lines.length > 0 && lineTotal === Math.round(total) };
}
