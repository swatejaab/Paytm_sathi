// Transparent credit-score estimate on the 300-900 scale used by Indian bureaus. Bureaus such as
// TransUnion CIBIL use proprietary models; this one uses the factors they are known to weigh, with
// every point explained, so customers can see what moves their score. Pure and deterministic.

export const CREDIT_MODEL_VERSION = 'saathi-credit-v1';

export interface CreditAccount {
  account_id: string;
  type: string;
  secured: boolean;
  lender: string;
  opened: string;
  sanctioned_inr?: number;
  limit_inr?: number;
  outstanding_inr: number;
  status: 'active' | 'closed';
}

export interface CreditReport {
  report_id: string;
  as_of: string;
  accounts: CreditAccount[];
  payment_history: { on_time_payments: number; late_payments: { account_id: string; dpd: number; months_ago: number }[] };
  enquiries_6m: number;
  new_accounts_6m: number;
}

export type FactorImpact = 'high' | 'medium' | 'low';

export interface ScoreFactor {
  id: 'payment_history' | 'utilisation' | 'credit_age' | 'credit_mix' | 'enquiries';
  label: string;
  value: string;
  points: number;
  max_points: number;
  status: 'good' | 'fair' | 'poor';
  detail: string;
  tip: string;
}

const monthsBetween = (from: string, to: string) => {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
};

const status = (points: number, max: number): ScoreFactor['status'] => (points >= max * 0.8 ? 'good' : points >= max * 0.55 ? 'fair' : 'poor');

export function bandFor(score: number): { band: string; tone: 'excellent' | 'good' | 'fair' | 'poor' } {
  if (score >= 750) return { band: 'Excellent', tone: 'excellent' };
  if (score >= 700) return { band: 'Good', tone: 'good' };
  if (score >= 650) return { band: 'Fair', tone: 'fair' };
  return { band: score >= 550 ? 'Needs work' : 'Poor', tone: 'poor' };
}

export function scoreReport(report: CreditReport) {
  const active = report.accounts.filter((account) => account.status === 'active');
  const cards = active.filter((account) => account.type === 'credit_card');

  // Payment history (210): late payments cost more when severe and recent.
  const latePenalty = report.payment_history.late_payments.reduce((sum, late) => {
    const severity = late.dpd >= 90 ? 160 : late.dpd >= 60 ? 100 : 60;
    const recency = late.months_ago < 12 ? 1 : late.months_ago < 24 ? 0.5 : 0.25;
    return sum + severity * recency;
  }, 0);
  const payment = Math.max(210 - latePenalty, 0);

  // Credit utilisation (180): card balances against limits.
  const limit = cards.reduce((sum, card) => sum + (card.limit_inr ?? 0), 0);
  const balance = cards.reduce((sum, card) => sum + card.outstanding_inr, 0);
  const utilisation = limit ? balance / limit : null;
  const util =
    utilisation === null ? 120 : utilisation <= 0.1 ? 180 : utilisation <= 0.3 ? 160 : utilisation <= 0.5 ? 110 : utilisation <= 0.75 ? 60 : 20;

  // Credit age (90): age of the oldest account (closed accounts stay on the report), full marks at 10 years.
  const ageMonths = report.accounts.length ? Math.max(...report.accounts.map((account) => monthsBetween(account.opened, report.as_of))) : 0;
  const age = Math.round(Math.min(ageMonths / 120, 1) * 90 * 10) / 10;

  // Credit mix (60): both secured and unsecured credit handled well.
  const hasSecured = active.some((account) => account.secured);
  const hasUnsecured = active.some((account) => !account.secured);
  const mix = hasSecured && hasUnsecured ? 60 : hasSecured || hasUnsecured ? 35 : 0;

  // New credit (60): recent hard enquiries and newly opened accounts.
  const enquiries = Math.max(60 - 15 * report.enquiries_6m - 10 * report.new_accounts_6m, 0);

  const factors: ScoreFactor[] = [
    {
      id: 'payment_history',
      label: 'Payment history',
      value: report.payment_history.late_payments.length
        ? `${report.payment_history.late_payments.length} late payment${report.payment_history.late_payments.length === 1 ? '' : 's'}`
        : 'Always on time',
      points: payment,
      max_points: 210,
      status: status(payment, 210),
      detail: report.payment_history.late_payments.length
        ? report.payment_history.late_payments.map((late) => `${late.dpd} days late, ${late.months_ago} months ago`).join('; ')
        : `${report.payment_history.on_time_payments} payments, none late`,
      tip: 'Pay every EMI and card bill on time; set autopay for at least the minimum due.',
    },
    {
      id: 'utilisation',
      label: 'Credit card use',
      value: utilisation === null ? 'No cards' : `${Math.round(utilisation * 100)}% of limit`,
      points: util,
      max_points: 180,
      status: status(util, 180),
      detail: utilisation === null ? 'No revolving credit on file.' : `INR ${balance.toLocaleString('en-IN')} used of INR ${limit.toLocaleString('en-IN')}`,
      tip: 'Keep card balances under 30% of the limit, ideally under 10%.',
    },
    {
      id: 'credit_age',
      label: 'Credit age',
      value: `${Math.floor(ageMonths / 12)} yr ${ageMonths % 12} mo`,
      points: age,
      max_points: 90,
      // Rated by years rather than share of points: full points need 10 years, but 5+ years is already strong.
      status: ageMonths >= 60 ? 'good' : ageMonths >= 24 ? 'fair' : 'poor',
      detail: 'Age of your oldest account; closed accounts still count.',
      tip: 'Keep your oldest card open, even if you use it lightly.',
    },
    {
      id: 'credit_mix',
      label: 'Credit mix',
      value: hasSecured && hasUnsecured ? 'Loan + card' : hasSecured ? 'Loans only' : hasUnsecured ? 'Cards only' : 'None',
      points: mix,
      max_points: 60,
      status: status(mix, 60),
      detail: `${active.length} open account${active.length === 1 ? '' : 's'}.`,
      tip: 'A mix of secured loans and cards, all paid on time, helps over time. Never borrow just for the score.',
    },
    {
      id: 'enquiries',
      label: 'New credit',
      value: `${report.enquiries_6m} enquir${report.enquiries_6m === 1 ? 'y' : 'ies'} in 6 months`,
      points: enquiries,
      max_points: 60,
      status: status(enquiries, 60),
      detail: `${report.new_accounts_6m} new account${report.new_accounts_6m === 1 ? '' : 's'} in 6 months.`,
      tip: 'Space out loan and card applications; each hard enquiry lowers the score for a while.',
    },
  ];
  const score = Math.round(Math.min(Math.max(300 + factors.reduce((sum, factor) => sum + factor.points, 0), 300), 900));
  return { score, ...bandFor(score), factors, utilisation, model: CREDIT_MODEL_VERSION };
}

export type ScoreAction = 'pay_card_to_10' | 'take_small_loan' | 'miss_one_emi' | 'close_oldest_card';

export const SCORE_ACTIONS: Record<ScoreAction, string> = {
  pay_card_to_10: 'Pay card balances down to 10% of the limit',
  take_small_loan: 'Take a new INR 15,000 loan',
  miss_one_emi: 'Miss one EMI by 30 days',
  close_oldest_card: 'Close my oldest credit card',
};

// Applies a hypothetical action to a copy of the report and re-scores it.
export function simulateAction(report: CreditReport, action: ScoreAction): CreditReport {
  const next: CreditReport = structuredClone(report);
  if (action === 'pay_card_to_10') {
    for (const card of next.accounts.filter((account) => account.type === 'credit_card' && account.status === 'active')) {
      card.outstanding_inr = Math.min(card.outstanding_inr, Math.floor((card.limit_inr ?? 0) * 0.1));
    }
  } else if (action === 'take_small_loan') {
    next.enquiries_6m += 1;
    next.new_accounts_6m += 1;
    next.accounts.push({ account_id: 'SIM-NEW-LOAN', type: 'personal_loan', secured: false, lender: 'Hypothetical', opened: next.as_of, sanctioned_inr: 15000, outstanding_inr: 15000, status: 'active' });
  } else if (action === 'miss_one_emi') {
    const loan = next.accounts.find((account) => account.type !== 'credit_card' && account.status === 'active') ?? next.accounts[0];
    next.payment_history.late_payments.push({ account_id: loan?.account_id ?? 'unknown', dpd: 30, months_ago: 0 });
  } else if (action === 'close_oldest_card') {
    const cards = next.accounts.filter((account) => account.type === 'credit_card' && account.status === 'active');
    const oldest = cards.sort((a, b) => a.opened.localeCompare(b.opened))[0];
    if (oldest) {
      oldest.status = 'closed';
      oldest.outstanding_inr = 0;
    }
  }
  return next;
}
