import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config';
import { buildTwin } from './twin';

interface BankAccount { institution: string; account_type: string; masked: string; balance_inr: number }
interface FixedDeposit { institution: string; name: string; principal_inr: number; value_inr: number; rate_pct: number; maturity_date: string }
interface MutualFund {
  scheme: string;
  amc: string;
  category: string;
  registrar: string;
  units: number;
  nav_inr: number;
  invested_inr: number;
  value_inr: number;
  sip_inr: number;
}
interface Stock {
  symbol: string;
  name: string;
  exchange: string;
  depository: string;
  quantity: number;
  avg_price_inr: number;
  ltp_inr: number;
  invested_inr: number;
  value_inr: number;
}
interface Retirement { name: string; institution: string; invested_inr: number; value_inr: number }
interface Gold { name: string; units: number; invested_inr: number; value_inr: number }

export interface CustomerHoldings {
  pan: string;
  pan_name: string;
  as_of: string;
  bank_accounts: BankAccount[];
  fixed_deposits: FixedDeposit[];
  mutual_funds: MutualFund[];
  stocks: Stock[];
  retirement: Retirement[];
  gold: Gold[];
  history: { month: string; net_worth_inr: number }[];
}

interface HoldingsFile {
  label: string;
  sources: { id: string; name: string; covers: string[] }[];
  customers: Record<string, CustomerHoldings>;
}

const file = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'holdings.json'), 'utf8')) as HoldingsFile;

export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function maskPan(pan: string): string {
  return `${pan.slice(0, 2)}${'X'.repeat(6)}${pan.slice(-2)}`;
}

export function holdingsFor(customerId: string): CustomerHoldings | null {
  return file.customers[customerId] ?? null;
}

export function panOnFile(customerId: string): string | null {
  return holdingsFor(customerId)?.pan ?? null;
}

export type AssetClass = 'savings' | 'fixed_deposits' | 'mutual_funds' | 'stocks' | 'retirement' | 'gold';

export interface AssetClassTotal {
  id: AssetClass;
  label: string;
  value_inr: number;
  invested_inr: number;
  count: number;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function total(id: AssetClass, label: string, items: { value: number; invested: number }[]): AssetClassTotal {
  return { id, label, value_inr: sum(items.map((item) => item.value)), invested_inr: sum(items.map((item) => item.invested)), count: items.length };
}

// One consolidated view of everything linked to the PAN, the way a CAS plus Account Aggregator pull would assemble it.
export function buildPortfolio(customerId: string) {
  const holdings = holdingsFor(customerId);
  if (!holdings) return null;
  const twin = buildTwin(customerId, { audit: false });
  const liabilities = (twin?.liabilities ?? []).map((line) => ({ label: line.label, value_inr: line.value_inr, source: line.source }));
  const valued = <T extends { value_inr: number; invested_inr: number }>(items: T[]) =>
    items.map((item) => ({ value: item.value_inr, invested: item.invested_inr }));

  const classes = [
    total('savings', 'Savings accounts', holdings.bank_accounts.map((item) => ({ value: item.balance_inr, invested: item.balance_inr }))),
    total('fixed_deposits', 'Fixed deposits', holdings.fixed_deposits.map((item) => ({ value: item.value_inr, invested: item.principal_inr }))),
    total('mutual_funds', 'Mutual funds', valued(holdings.mutual_funds)),
    total('stocks', 'Stocks', valued(holdings.stocks)),
    total('retirement', 'PPF and EPF', valued(holdings.retirement)),
    total('gold', 'Gold', valued(holdings.gold)),
  ].filter((item) => item.count > 0);

  const totalAssets = sum(classes.map((item) => item.value_inr));
  const totalLiabilities = sum(liabilities.map((item) => item.value_inr));
  const netWorth = totalAssets - totalLiabilities;
  const market = classes.filter((item) => item.id === 'mutual_funds' || item.id === 'stocks' || item.id === 'gold');
  const marketValue = sum(market.map((item) => item.value_inr));
  const marketInvested = sum(market.map((item) => item.invested_inr));
  const liquid = sum(classes.filter((item) => item.id === 'savings' || item.id === 'fixed_deposits').map((item) => item.value_inr));
  const history = holdings.history.map((point, index, all) =>
    index === all.length - 1 ? { ...point, net_worth_inr: netWorth } : point,
  );

  return {
    pan_masked: maskPan(holdings.pan),
    pan_name: holdings.pan_name,
    as_of: holdings.as_of,
    total_assets_inr: totalAssets,
    total_liabilities_inr: totalLiabilities,
    net_worth_inr: netWorth,
    liquid_inr: liquid,
    market_value_inr: marketValue,
    market_gain_inr: marketValue - marketInvested,
    market_gain_pct: marketInvested > 0 ? Math.round(((marketValue - marketInvested) / marketInvested) * 1000) / 10 : 0,
    monthly_sip_inr: sum(holdings.mutual_funds.map((item) => item.sip_inr)),
    classes,
    holdings: {
      bank_accounts: holdings.bank_accounts,
      fixed_deposits: holdings.fixed_deposits,
      mutual_funds: holdings.mutual_funds,
      stocks: holdings.stocks,
      retirement: holdings.retirement,
      gold: holdings.gold,
    },
    liabilities,
    history,
    sources: file.sources.map(({ id, name }) => ({ id, name })),
    simulated: true,
    notice: file.label,
  };
}

export type Portfolio = NonNullable<ReturnType<typeof buildPortfolio>>;
