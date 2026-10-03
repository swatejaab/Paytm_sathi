import { EVENT_LABELS, factValue, inr, sourceLabel } from './format';
import type { Passport } from './types';

const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function passportSummary(passport: Passport): string {
  const lines = [
    `Saathi Resolution Passport ${passport.passport_id} (case ${passport.case_id})`,
    `Event: ${EVENT_LABELS[passport.event.type]}, ${passport.event.urgency} urgency`,
    `Story: "${passport.story}"`,
  ];
  if (passport.calculation) {
    const calc = passport.calculation;
    lines.push(
      `Exact gap: ${inr(calc.bill_total_inr)} bill - ${inr(calc.coverage_estimate_inr)} cover - ${inr(calc.customer_contribution_inr)} paid = ${inr(calc.exact_gap_inr)}`,
    );
  }
  if (passport.transaction) {
    lines.push(`Transaction: ${passport.transaction.transaction_id}, ${inr(passport.transaction.amount_inr)} to ${passport.transaction.counterparty}`);
  }
  if (passport.recommended_option) lines.push(`Recommended: ${passport.recommended_option}`);
  if (passport.missing_documents.length) lines.push(`Missing documents: ${passport.missing_documents.join(', ')}`);
  lines.push(...passport.facts.map((fact) => `- ${fact.label}: ${factValue(fact)} (source: ${sourceLabel(fact.source)})`));
  lines.push(passport.notice);
  return lines.join('\n');
}

// Opens a print-ready, self-contained page; the browser's "Save as PDF" produces the shareable file.
export function printPassport(passport: Passport): boolean {
  const facts = passport.facts
    .map((fact) => `<tr><td>${escape(fact.label)}</td><td><b>${escape(factValue(fact))}</b></td><td>${escape(sourceLabel(fact.source))}</td></tr>`)
    .join('');
  const calc = passport.calculation;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(passport.passport_id)}</title>
<style>
  body { font: 13px/1.5 "Segoe UI", system-ui, sans-serif; color: #10264b; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; } .muted { color: #5a6b85; }
  .band { border: 1px solid #d8e2ef; border-radius: 10px; padding: 12px 14px; margin: 12px 0; }
  .gap { font-size: 16px; } table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  td, th { border-bottom: 1px solid #e6edf6; padding: 6px 4px; text-align: left; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #5a6b85; }
  .brand { display: inline-block; background: #00b9e8; color: #fff; border-radius: 6px; padding: 2px 8px; font-weight: 700; }
  @media print { body { margin: 12mm; } }
</style></head><body>
<p><span class="brand">Paytm Saathi</span> <span class="muted">Resolution Passport: tell it once</span></p>
<h1>${escape(passport.passport_id)}</h1>
<p class="muted">Case ${escape(passport.case_id)} / ${escape(EVENT_LABELS[passport.event.type])} / ${escape(passport.event.urgency)} urgency</p>
<div class="band"><b>Customer's words</b><br>"${escape(passport.story)}"</div>
${calc ? `<div class="band gap"><b>Exact gap:</b> ${escape(inr(calc.bill_total_inr))} bill - ${escape(inr(calc.coverage_estimate_inr))} estimated cover - ${escape(inr(calc.customer_contribution_inr))} customer pays = <b>${escape(inr(calc.exact_gap_inr))}</b></div>` : ''}
${passport.transaction ? `<div class="band"><b>Transaction:</b> ${escape(passport.transaction.transaction_id)}, ${escape(inr(passport.transaction.amount_inr))} to ${escape(passport.transaction.counterparty)}</div>` : ''}
${passport.recommended_option ? `<div class="band"><b>Recommended path:</b> ${escape(passport.recommended_option)}</div>` : ''}
${passport.missing_documents.length ? `<div class="band"><b>Still needed:</b> ${escape(passport.missing_documents.join(', '))}</div>` : ''}
${facts ? `<table><thead><tr><th>Fact</th><th>Value</th><th>Source</th></tr></thead><tbody>${facts}</tbody></table>` : ''}
<p class="muted">Documents: ${escape(passport.documents.map((document) => document.document_name).join(', ') || 'none')}<br>
Consent: ${escape(passport.consents.map((consent) => `${consent.purpose.replace(/_/g, ' ')} (${consent.status})`).join('; ') || 'not granted')}</p>
<p class="muted">${escape(passport.notice)}</p>
</body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, '_blank');
  // Printed from the opener: the app's CSP blocks inline scripts inside the blob page.
  opened?.addEventListener('load', () => opened.print());
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Boolean(opened);
}
