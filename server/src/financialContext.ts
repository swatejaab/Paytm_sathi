import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config';
import { fixtures } from './fixtures';
import { listGoals, type GoalView } from './goals';
import { buildTwin } from './twin';

export interface StatementMonth {
  month: string;
  income_inr: number;
  emi_inr: number;
  invested_inr: number;
  spending: Record<string, number>;
}

const statements = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'statements.json'), 'utf8')) as {
  customers: Record<string, { source: string; months: StatementMonth[] }>;
};

export function statementsFor(customerId: string): { source: string; months: StatementMonth[] } | null {
  return statements.customers[customerId] ?? null;
}

export const monthSpending = (month: StatementMonth): number =>
  Object.values(month.spending).reduce((sum, value) => sum + value, 0) + month.emi_inr;

// The mini financial twin Saathi reasons over. Anything not on record stays null; Saathi asks instead of guessing.
export interface FinancialContext {
  monthlyIncome: number | null;
  averageExpenses: number | null;
  availableCash: number | null;
  emergencyFund: number | null;
  existingLoans: { name: string; outstanding_inr: number; emi_inr: number | null; next_due_date: string | null }[] | null;
  monthlyEMIs: number | null;
  insurancePolicies: { policy: string; kind: string; cover_inr: number; renewal_date: string; days_to_renewal: number }[] | null;
  investments: { name: string; value_inr: number }[] | null;
  upcomingBills: { title: string; amount_inr: number; due_date: string; days_away: number }[] | null;
  financialGoals: GoalView[];
  sources: Record<string, string>;
}

export function financialContext(customerId: string): FinancialContext {
  const twin = buildTwin(customerId, { audit: false });
  const goals = listGoals(customerId).filter((goal) => goal.status !== 'completed');
  if (!twin) {
    return {
      monthlyIncome: null,
      averageExpenses: null,
      availableCash: null,
      emergencyFund: null,
      existingLoans: null,
      monthlyEMIs: null,
      insurancePolicies: null,
      investments: null,
      upcomingBills: null,
      financialGoals: goals,
      sources: {},
    };
  }
  const statement = statementsFor(customerId);
  const averageExpenses = statement?.months.length
    ? Math.round(statement.months.reduce((sum, month) => sum + monthSpending(month), 0) / statement.months.length)
    : twin.cash_flow.essentials_inr + twin.cash_flow.emi_inr;
  const loans = fixtures.loans.accounts[customerId]?.loans ?? [];
  return {
    monthlyIncome: twin.cash_flow.income_inr,
    averageExpenses,
    availableCash: twin.before_salary.balance_inr,
    emergencyFund: twin.emergency.savings_inr,
    existingLoans: twin.liabilities.map((line) => {
      const loan = loans.find((item) => line.label.includes(item.loan_id));
      return { name: line.label, outstanding_inr: line.value_inr, emi_inr: loan?.emi_inr ?? null, next_due_date: loan?.next_due_date ?? null };
    }),
    monthlyEMIs: twin.cash_flow.emi_inr,
    insurancePolicies: twin.insurance.map((policy) => ({
      policy: policy.policy,
      kind: policy.kind,
      cover_inr: policy.cover_inr,
      renewal_date: policy.renewal_date,
      days_to_renewal: policy.days_to_renewal,
    })),
    investments: twin.assets.slice(2).map((asset) => ({ name: asset.label, value_inr: asset.value_inr })),
    upcomingBills: twin.obligations
      .filter((item) => item.direction === 'out')
      .map((item) => ({ title: item.title, amount_inr: item.amount_inr, due_date: item.due_date, days_away: item.days_away })),
    financialGoals: goals,
    sources: {
      monthlyIncome: twin.cash_flow.source,
      averageExpenses: statement?.source ?? twin.cash_flow.source,
      availableCash: twin.cash_flow.source,
      emergencyFund: twin.cash_flow.source,
      financialGoals: 'Your goals in Saathi',
    },
  };
}
