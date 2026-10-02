import { formatInr } from '../decision';
import type { CaseRecord, Language } from '../types';

const HINGLISH_MARKERS = [
  'hai', 'hain', 'kya', 'karun', 'karu', 'mein', 'mera', 'mere', 'meri', 'nahi', 'nahin', 'kiya', 'maine',
  'paisa', 'paise', 'aur', 'ab', 'kaise', 'kab', 'hua', 'gaya', 'chahiye', 'madad', 'bhai', 'papa', 'mummy',
];

export function detectLanguage(message: string): Language {
  const words = new Set(message.toLowerCase().match(/[a-z]+/g) ?? []);
  const hits = HINGLISH_MARKERS.filter((marker) => words.has(marker)).length;
  return hits >= 2 ? 'hinglish' : 'en';
}

// Builds the customer-facing explanation from the deterministic decision only.
// It never introduces a number that the decision service did not produce.
export function explainDecision(record: CaseRecord): string {
  const decision = record.decision;
  if (!decision) return '';
  const hinglish = record.language === 'hinglish';
  const best = decision.options.find((option) => option.recommended);
  const calc = decision.calculation;
  const parts: string[] = [];

  if (calc) {
    parts.push(
      hinglish
        ? `Exact gap: ${formatInr(calc.bill_total_inr)} bill - ${formatInr(calc.coverage_estimate_inr)} insurance estimate - ${formatInr(calc.customer_contribution_inr)} jo aap abhi de sakte hain = ${formatInr(calc.exact_gap_inr)}.`
        : `Exact gap: ${formatInr(calc.bill_total_inr)} bill - ${formatInr(calc.coverage_estimate_inr)} estimated cover - ${formatInr(calc.customer_contribution_inr)} you can pay = ${formatInr(calc.exact_gap_inr)}.`,
    );
  }

  if (hinglish) {
    if (best) {
      parts.push(`Sabse accha raasta: ${best.title} (${best.scores.total}/100). ${best.summary}`);
      const runnerUp = decision.options.find((option) => option.feasible && !option.recommended);
      if (runnerUp) parts.push(`Doosra option: ${runnerUp.title} (${runnerUp.scores.total}/100).`);
    } else {
      parts.push('Koi bhi automated option safety checks pass nahi karta, isliye ek Saathi specialist aapka case dekhega.');
    }
    if (decision.requires_verification) parts.push('Aapke documents verify hone tak claim aur loan steps ruke rahenge.');
    parts.push('Aapke approve kiye bina kuch bhi submit nahi hoga.');
  } else {
    parts.push(decision.explanation);
    parts.push(
      record.event_type === 'upi_dispute' ? 'Nothing is filed until you approve.' : 'Nothing is submitted until you approve a specific plan.',
    );
  }
  return parts.join(' ');
}

export function consentNeededMessage(language: Language | undefined): string {
  return language === 'hinglish'
    ? 'Maine aapka case save kar liya hai. Aapke policy, bill ya account records padhne se pehle, is case ke liye consent dijiye.'
    : 'I saved your case. Before I read your synthetic policy, bill, or account records, please grant consent for this case.';
}

export function pickTransactionMessage(language: Language | undefined, count: number, stated: number | null, matched: boolean): string {
  if (language === 'hinglish') {
    return stated && matched
      ? `Mujhe ${formatInr(stated)} ke ${count} debit mile. Jo payment aapne nahi kiya, use chuniye. Kuch bhi file karne se pehle main evidence dikhaunga.`
      : 'Ye aapke recent debits hain. Jo payment aap nahi pehchaante, use chuniye. Kuch bhi file karne se pehle main evidence dikhaunga.';
  }
  return stated && matched
    ? `I found ${count} debit(s) of ${formatInr(stated)}. Pick the one you don't recognize. I will show the evidence before anything is filed.`
    : 'Here are your recent debits. Pick the one you do not recognize. I will show the evidence before anything is filed.';
}
