import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, settings } from './config';
import { recordAudit } from './db';
import { formatInr } from './decision';
import { fixtures } from './fixtures';

interface TwinExtras {
  investments: { name: string; kind: string; value_inr: number; source: string }[];
  credit_cards: { name: string; outstanding_inr: number; limit_inr: number; due_date: string; source: string }[];
  insurance: { policy: string; kind: string; cover_inr: number; premium_inr: number; renewal_date: string; insurer: string }[];
  goals: { goal: string; target_inr: number; saved_inr: number; target_date: string }[];
  obligations: { title: string; kind: string; amount_inr: number; due_date: string }[];
}

const extras = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'twin.json'), 'utf8')) as {
  customers: Record<string, TwinExtras>;
};

export interface TwinLine {
  label: string;
  value_inr: number;
  source: string;
}

export interface TwinObligation {
  title: string;
  kind: string;
  amount_inr: number;
  due_date: string;
  days_away: number;
  direction: 'in' | 'out';
  source: string;
}

const dayDiff = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const addMonths = (date: string, months: number): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
};

// The Saathi Financial Twin: one sourced picture of the customer's money, assembled from the same records the MCP tools serve.
export function buildTwin(customerId: string) {
  const profile = fixtures.profiles[customerId];
  if (!profile) return null;
  const loans = fixtures.loans.accounts[customerId];
  const more = extras.customers[customerId] ?? { investments: [], credit_cards: [], insurance: [], goals: [], obligations: [] };
  const today = settings.demoDate;

  const assets: TwinLine[] = [
    { label: 'Bank and wallet balance', value_inr: profile.account_balance_inr, source: profile.source },
    { label: 'Emergency savings', value_inr: profile.emergency_savings_inr, source: profile.source },
    ...more.investments.map((item) => ({ label: item.name, value_inr: item.value_inr, source: item.source })),
  ];
  const liabilities: TwinLine[] = [
    ...(loans?.loans ?? []).map((loan) => ({
      label: `${loan.product} (${loan.loan_id})`,
      value_inr: loan.outstanding_principal_inr,
      source: fixtures.loans.partner,
    })),
    ...more.credit_cards.map((card) => ({ label: card.name, value_inr: card.outstanding_inr, source: card.source })),
  ];
  const sum = (lines: TwinLine[]) => lines.reduce((total, line) => total + line.value_inr, 0);

  let salaryDate = loans?.salary.expected_date ?? today;
  while (salaryDate < today) salaryDate = addMonths(salaryDate, 1);

  const obligations: TwinObligation[] = [
    ...more.obligations.map((item) => ({ ...item, source: 'Synthetic bills and mandates' })),
    ...(loans?.loans ?? []).map((loan) => ({
      title: `${loan.product} EMI`,
      kind: 'emi',
      amount_inr: loan.emi_inr,
      due_date: loan.next_due_date,
      source: fixtures.loans.partner,
    })),
    ...more.credit_cards.map((card) => ({
      title: `${card.name} bill`,
      kind: 'credit_card',
      amount_inr: card.outstanding_inr,
      due_date: card.due_date,
      source: card.source,
    })),
  ]
    .map((item): TwinObligation => ({ ...item, direction: 'out', days_away: dayDiff(today, item.due_date) }))
    .concat(
      loans
        ? ([
            {
              title: loans.salary.status === 'delayed' ? 'Salary (delayed)' : 'Salary',
              kind: 'salary',
              amount_inr: loans.salary.amount_inr,
              due_date: salaryDate,
              source: loans.salary.source,
              direction: 'in',
              days_away: dayDiff(today, salaryDate),
            },
          ] satisfies TwinObligation[])
        : [],
    )
    .filter((item) => item.days_away >= 0 && item.days_away <= 31)
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || (a.direction === 'in' ? -1 : 1));

  // Bills that fall before the next salary credit, against what is in the account today.
  const dueBeforeSalary = obligations.filter((item) => item.direction === 'out' && item.due_date < salaryDate);
  const dueBeforeSalaryInr = dueBeforeSalary.reduce((total, item) => total + item.amount_inr, 0);
  const crunchInr = Math.max(dueBeforeSalaryInr - profile.account_balance_inr, 0);

  const freeCash = profile.monthly_income_inr - profile.monthly_essential_expenses_inr - profile.existing_emi_inr;
  const emergencyMonths = profile.monthly_essential_expenses_inr
    ? Math.round((profile.emergency_savings_inr / profile.monthly_essential_expenses_inr) * 10) / 10
    : 0;
  const renewalSoon = more.insurance.filter((policy) => {
    const days = dayDiff(today, policy.renewal_date);
    return days >= 0 && days <= 30;
  });

  const summary =
    crunchInr > 0
      ? {
          status: 'attention' as const,
          headline: `${formatInr(dueBeforeSalaryInr)} is due before your salary on ${salaryDate}, but your balance is ${formatInr(profile.account_balance_inr)}.`,
        }
      : emergencyMonths < 3
        ? { status: 'watch' as const, headline: `Your money is on track this week; your emergency fund covers ${emergencyMonths} months of expenses.` }
        : { status: 'healthy' as const, headline: 'Your money looks healthy this week.' };

  recordAudit({ actor: customerId, event: 'twin_viewed' });
  return {
    customer_id: customerId,
    as_of: today,
    summary,
    net_position: { assets_inr: sum(assets), liabilities_inr: sum(liabilities), net_inr: sum(assets) - sum(liabilities) },
    assets,
    liabilities,
    cash_flow: {
      income_inr: profile.monthly_income_inr,
      essentials_inr: profile.monthly_essential_expenses_inr,
      emi_inr: profile.existing_emi_inr,
      free_cash_inr: freeCash,
      emi_to_income: profile.monthly_income_inr ? Math.round((profile.existing_emi_inr / profile.monthly_income_inr) * 1000) / 1000 : 0,
      source: profile.source,
    },
    emergency: {
      savings_inr: profile.emergency_savings_inr,
      months_covered: emergencyMonths,
      buffer_inr: profile.minimum_emergency_buffer_inr,
    },
    before_salary: { salary_date: salaryDate, due_inr: dueBeforeSalaryInr, balance_inr: profile.account_balance_inr, shortfall_inr: crunchInr },
    obligations,
    insurance: more.insurance.map((policy) => ({ ...policy, days_to_renewal: dayDiff(today, policy.renewal_date) })),
    renewals_due: renewalSoon.map((policy) => policy.policy),
    goals: more.goals.map((goal) => {
      const months = Math.max(Math.round(dayDiff(today, goal.target_date) / 30.4), 1);
      const remaining = Math.max(goal.target_inr - goal.saved_inr, 0);
      return {
        ...goal,
        progress_pct: Math.min(Math.round((goal.saved_inr / goal.target_inr) * 100), 100),
        monthly_needed_inr: Math.ceil(remaining / months / 100) * 100,
        months_left: months,
      };
    }),
    notice: 'Synthetic demo data. Saathi reads these records for you; nothing here is shared without your consent.',
  };
}

export type FinancialTwin = NonNullable<ReturnType<typeof buildTwin>>;
