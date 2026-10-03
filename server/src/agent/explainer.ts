import { detectLanguageOf } from '../assistant/nlu';
import { formatDay, formatInr } from '../decision';
import type { CaseRecord, Language } from '../types';

export function detectLanguage(message: string): Language {
  return detectLanguageOf(message);
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
    const insured = calc.coverage_estimate_inr > 0;
    const coverFact = decision.facts.find((fact) => fact.name === 'estimated_coverage_inr');
    const fromInsurer = coverFact?.source.type === 'policy_clause';
    const cashless = fromInsurer && Boolean(record.context?.records?.admission?.cashless);
    if (insured && fromInsurer) {
      const cover = formatInr(calc.coverage_estimate_inr);
      const pay = formatInr(calc.customer_contribution_inr);
      const gap = formatInr(calc.exact_gap_inr);
      parts.push(
        hinglish
          ? `${cashless ? 'Cashless' : 'Aapki policy'} ${cover} cover karegi. Aap abhi ${pay} de sakte hain. ${calc.exact_gap_inr > 0 ? `Asli gap sirf ${gap} hai.` : 'Koi gap nahi bacha.'}`
          : `${cashless ? 'Cashless covers' : 'Your policy covers about'} ${cover}. You can pay ${pay} now. ${calc.exact_gap_inr > 0 ? `The real gap is ${gap}.` : 'There is no gap left to fund.'}`,
      );
    } else {
      const terms = [
        `${formatInr(calc.bill_total_inr)} bill`,
        ...(insured ? [hinglish ? `${formatInr(calc.coverage_estimate_inr)} insurance` : `${formatInr(calc.coverage_estimate_inr)} expected insurance`] : []),
        hinglish ? `${formatInr(calc.customer_contribution_inr)} jo aap abhi de sakte hain` : `${formatInr(calc.customer_contribution_inr)} you can pay`,
      ];
      parts.push(`Funding gap: ${terms.join(' - ')} = ${formatInr(calc.exact_gap_inr)}.`);
    }
  }

  const factValue = (name: string) => decision.facts.find((fact) => fact.name === name)?.value;
  const shortfall = factValue('shortfall_inr');
  if (typeof shortfall === 'number' && shortfall > 0) {
    const emi = formatInr(Number(factValue('emi_inr')));
    const due = formatDay(String(factValue('next_due_date')));
    const available = formatInr(Math.max(Number(factValue('account_balance_inr')) - Number(factValue('committed_before_due_inr')), 0));
    parts.push(
      hinglish
        ? `EMI ${emi} hai, due date ${due} se pehle ${available} available hai, toh ${formatInr(shortfall)} kam pad rahe hain.`
        : `Your EMI is ${emi}, due ${due}. About ${available} is free before then, so you are ${formatInr(shortfall)} short.`,
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
    ? 'Aapke policy, bill ya account records padhne se pehle, is conversation ke liye permission dijiye.'
    : 'Before I read your policy, bill, or account records, please allow access for this conversation.';
}

export function pickTransactionMessage(language: Language | undefined, count: number, stated: number | null, matched: boolean): string {
  if (!count) {
    return language === 'hinglish'
      ? 'Mujhe aapke recent debits mein koi matching payment nahi mila. Aap ek Saathi specialist se baat kar sakte hain.'
      : 'I could not find a matching debit in your recent transactions. A Saathi specialist can look into it with you.';
  }
  if (language === 'hinglish') {
    return stated && matched
      ? `Mujhe ${formatInr(stated)} ke ${count} debit mile. Jo payment aapne nahi kiya, use chuniye. Kuch bhi file karne se pehle main evidence dikhaunga.`
      : 'Ye aapke recent debits hain. Jo payment aap nahi pehchaante, use chuniye. Kuch bhi file karne se pehle main evidence dikhaunga.';
  }
  return stated && matched
    ? `I found ${count} debit${count === 1 ? '' : 's'} of ${formatInr(stated)}. Pick the one you don't recognize. I will show the evidence before anything is filed.`
    : "Here are your recent debits. Pick the one you don't recognize. I will show the evidence before anything is filed.";
}
