import { useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../api';
import { inr, shortDate } from '../format';
import type { AssetClassId, AssetsResponse, Portfolio } from '../types';
import { BarList, CHART_COLORS, DonutChart, LineChart } from './charts';
import { Icon } from './Icon';
import { ConfirmDialog, ErrorState, Kpi, Panel, Skeleton, useAsync } from './ui';

const FETCH_STEPS = [
  'Verifying your PAN',
  'Reading demat holdings from CDSL and NSDL',
  'Reading mutual funds from CAMS and KFintech',
  'Reading bank and FD balances through Account Aggregator',
];

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const signed = (value: number) => `${value >= 0 ? '+' : '−'}${inr(Math.abs(value))}`;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const monthLabel = (month: string) => new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });

function LinkForm({ panOnFile, onLinked }: { panOnFile: string | null; onLinked: (result: AssetsResponse) => void }) {
  const [pan, setPan] = useState('');
  const [useKyc, setUseKyc] = useState(Boolean(panOnFile));
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const typed = pan.replace(/\s+/g, '').toUpperCase();
  const ready = consent && (useKyc || PAN_PATTERN.test(typed));

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setStep((current) => Math.min(current + 1, FETCH_STEPS.length - 1)), 450);
    return () => window.clearInterval(timer);
  }, [busy]);

  const link = async () => {
    setBusy(true);
    setStep(0);
    setError(null);
    try {
      const [result] = await Promise.all([
        api.linkAssets(useKyc ? { use_kyc_pan: true } : { pan: typed }),
        new Promise((resolve) => window.setTimeout(resolve, FETCH_STEPS.length * 450)),
      ]);
      onLinked(result);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <section className="card assets-link">
      <div className="assets-link-intro">
        <span className="assets-link-icon">
          <Icon name="wallet" size={26} />
        </span>
        <div>
          <p className="eyebrow">Assets &amp; net worth</p>
          <h3>See everything you own in one place</h3>
          <p className="muted small">
            Saathi uses your PAN to find stocks, mutual funds, fixed deposits, savings accounts, PPF and EPF across banks and brokers, then adds up
            your net worth after loans and card dues.
          </p>
        </div>
      </div>

      <ul className="assets-sources" aria-label="Where the data comes from">
        <li>
          <strong>Stocks</strong>
          <small>CDSL and NSDL demat</small>
        </li>
        <li>
          <strong>Mutual funds</strong>
          <small>CAMS and KFintech</small>
        </li>
        <li>
          <strong>Bank and FDs</strong>
          <small>Account Aggregator</small>
        </li>
        <li>
          <strong>PPF and EPF</strong>
          <small>Passbooks</small>
        </li>
      </ul>

      {busy ? (
        <ol className="assets-steps" aria-live="polite">
          {FETCH_STEPS.map((label, index) => (
            <li key={label} className={index < step ? 'done' : index === step ? 'active' : ''}>
              <span className="assets-step-dot">{index < step ? <Icon name="check" size={12} /> : null}</span>
              {label}
            </li>
          ))}
        </ol>
      ) : (
        <div className="assets-form">
          {panOnFile && (
            <label className="radio-row">
              <input type="radio" name="pan-choice" checked={useKyc} onChange={() => setUseKyc(true)} />
              <span>
                Use the PAN verified on my Paytm KYC <strong>{panOnFile}</strong>
              </span>
            </label>
          )}
          <label className="radio-row">
            <input type="radio" name="pan-choice" checked={!useKyc} onChange={() => setUseKyc(false)} />
            <span>Enter my PAN</span>
          </label>
          {!useKyc && (
            <input
              className="input pan-input"
              aria-label="PAN"
              placeholder="ABCDE1234F"
              maxLength={10}
              value={pan}
              autoComplete="off"
              onChange={(event) => setPan(event.target.value.toUpperCase())}
            />
          )}
          <label className="assets-consent">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>
              I allow Saathi to fetch the holdings linked to this PAN to show my net worth. Read-only: nothing is bought, sold or moved, and I can unlink at
              any time.
            </span>
          </label>
          {error && <p className="alert alert-error small">{error}</p>}
          <button className="btn btn-primary" disabled={!ready} onClick={() => void link()}>
            <Icon name="link" size={16} /> Fetch my holdings
          </button>
          <small className="muted">Demo: holdings are simulated sample data, not real CDSL, NSDL, CAMS or KFintech records.</small>
        </div>
      )}
    </section>
  );
}

function HoldingTable({ title, total, children, head }: { title: string; total: number; children: ReactNode; head: string[] }) {
  return (
    <details className="card holding-group" open>
      <summary>
        <span>{title}</span>
        <strong>{inr(total)}</strong>
      </summary>
      <div className="table-scroll">
        <table className="holdings-table">
          <thead>
            <tr>
              {head.map((cell, index) => (
                <th key={cell} className={index ? 'num' : ''}>
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </details>
  );
}

function Gain({ value, invested }: { value: number; invested: number }) {
  const gain = value - invested;
  return (
    <span className={gain >= 0 ? 'gain-up' : 'gain-down'}>
      {signed(gain)} <small>({pct(gain, invested)}%)</small>
    </span>
  );
}

function PortfolioView({ portfolio, linkedAt, onUnlink, onRefresh, onAsk }: {
  portfolio: Portfolio;
  linkedAt: string;
  onUnlink: () => void;
  onRefresh: () => void;
  onAsk: (text: string) => void;
}) {
  const classTotal = (id: AssetClassId) => portfolio.classes.find((item) => item.id === id)?.value_inr ?? 0;
  const equity = classTotal('stocks') + classTotal('mutual_funds');
  const { holdings } = portfolio;

  return (
    <>
      <div className="kpi-grid">
        <Kpi icon="wallet" label="Net worth" value={inr(portfolio.net_worth_inr)} note={`Assets minus loans and card dues`} tone="good" />
        <Kpi icon="trend" label="Total assets" value={inr(portfolio.total_assets_inr)} note={`${portfolio.classes.length} asset types`} />
        <Kpi icon="card" label="Liabilities" value={inr(portfolio.total_liabilities_inr)} note={`${portfolio.liabilities.length} loan or card balance${portfolio.liabilities.length === 1 ? '' : 's'}`} />
        <Kpi
          icon="insights"
          label="Investment gains"
          value={signed(portfolio.market_gain_inr)}
          note={`${portfolio.market_gain_pct}% on stocks, funds and gold`}
          tone={portfolio.market_gain_inr >= 0 ? 'good' : 'alert'}
        />
        <Kpi icon="shield" label="Cash and FDs" value={inr(portfolio.liquid_inr)} note="Available quickly in an emergency" />
        <Kpi icon="calendar" label="Monthly SIPs" value={inr(portfolio.monthly_sip_inr)} note={`${pct(equity, portfolio.total_assets_inr)}% of assets in equity`} />
      </div>

      <div className="charts-layout">
        <Panel title="Asset allocation" subtitle={`As of ${shortDate(portfolio.as_of)}`}>
          <DonutChart
            slices={portfolio.classes.map((item) => ({ label: item.label, value: item.value_inr }))}
            centerLabel="Total assets"
            ariaLabel="Asset allocation"
          />
        </Panel>
        <Panel title="Net worth trend" subtitle="Last 6 months">
          <LineChart
            points={portfolio.history.map((point) => ({ label: monthLabel(point.month), values: { net: point.net_worth_inr } }))}
            series={[{ key: 'net', label: 'Net worth', color: CHART_COLORS[0]! }]}
          />
        </Panel>
        <Panel title="By asset type" subtitle="Current value and share of assets">
          <BarList
            rows={portfolio.classes.map((item, index) => ({
              label: item.label,
              value: item.value_inr,
              color: CHART_COLORS[index % CHART_COLORS.length],
              secondary: `${pct(item.value_inr, portfolio.total_assets_inr)}% · ${item.count} holding${item.count === 1 ? '' : 's'}`,
            }))}
          />
        </Panel>
        <Panel title="What you owe" subtitle={inr(portfolio.total_liabilities_inr)}>
          {portfolio.liabilities.length ? (
            <BarList rows={portfolio.liabilities.map((item) => ({ label: item.label, value: item.value_inr, color: 'var(--danger)', secondary: item.source }))} />
          ) : (
            <p className="muted">No loans or card balances.</p>
          )}
        </Panel>
      </div>

      <div className="ask-chips">
        <span className="muted small">Ask Saathi:</span>
        {['How is my money invested?', 'Is my portfolio too risky?', 'How much can I use in an emergency?'].map((text) => (
          <button key={text} className="chip" onClick={() => onAsk(text)}>
            <Icon name="sparkle" size={14} /> {text}
          </button>
        ))}
      </div>

      <div className="holding-groups">
        {holdings.stocks.length > 0 && (
          <HoldingTable title="Stocks" total={classTotal('stocks')} head={['Stock', 'Qty', 'Avg price', 'Price', 'Value', 'Gain']}>
            {holdings.stocks.map((item) => (
              <tr key={item.symbol}>
                <td>
                  <strong>{item.name}</strong>
                  <small className="muted">
                    {item.exchange}: {item.symbol} · {item.depository}
                  </small>
                </td>
                <td className="num">{item.quantity}</td>
                <td className="num">{inr(item.avg_price_inr)}</td>
                <td className="num">{inr(item.ltp_inr)}</td>
                <td className="num">{inr(item.value_inr)}</td>
                <td className="num">
                  <Gain value={item.value_inr} invested={item.invested_inr} />
                </td>
              </tr>
            ))}
          </HoldingTable>
        )}
        {holdings.mutual_funds.length > 0 && (
          <HoldingTable title="Mutual funds" total={classTotal('mutual_funds')} head={['Scheme', 'Units', 'NAV', 'Invested', 'Value', 'Gain']}>
            {holdings.mutual_funds.map((item) => (
              <tr key={item.scheme}>
                <td>
                  <strong>{item.scheme}</strong>
                  <small className="muted">
                    {item.category} · {item.registrar}
                    {item.sip_inr ? ` · SIP ${inr(item.sip_inr)}/month` : ''}
                  </small>
                </td>
                <td className="num">{item.units.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</td>
                <td className="num">{inr(item.nav_inr)}</td>
                <td className="num">{inr(item.invested_inr)}</td>
                <td className="num">{inr(item.value_inr)}</td>
                <td className="num">
                  <Gain value={item.value_inr} invested={item.invested_inr} />
                </td>
              </tr>
            ))}
          </HoldingTable>
        )}
        {holdings.fixed_deposits.length > 0 && (
          <HoldingTable title="Fixed deposits" total={classTotal('fixed_deposits')} head={['Deposit', 'Rate', 'Matures', 'Principal', 'Value']}>
            {holdings.fixed_deposits.map((item) => (
              <tr key={`${item.institution}-${item.name}`}>
                <td>
                  <strong>{item.name}</strong>
                  <small className="muted">{item.institution}</small>
                </td>
                <td className="num">{item.rate_pct}%</td>
                <td className="num">{shortDate(item.maturity_date)}</td>
                <td className="num">{inr(item.principal_inr)}</td>
                <td className="num">{inr(item.value_inr)}</td>
              </tr>
            ))}
          </HoldingTable>
        )}
        {holdings.bank_accounts.length > 0 && (
          <HoldingTable title="Savings accounts" total={classTotal('savings')} head={['Account', 'Number', 'Balance']}>
            {holdings.bank_accounts.map((item) => (
              <tr key={item.masked}>
                <td>
                  <strong>{item.institution}</strong>
                  <small className="muted">{item.account_type}</small>
                </td>
                <td className="num">{item.masked}</td>
                <td className="num">{inr(item.balance_inr)}</td>
              </tr>
            ))}
          </HoldingTable>
        )}
        {holdings.retirement.length > 0 && (
          <HoldingTable title="PPF and EPF" total={classTotal('retirement')} head={['Account', 'Contributed', 'Value']}>
            {holdings.retirement.map((item) => (
              <tr key={item.name}>
                <td>
                  <strong>{item.name}</strong>
                  <small className="muted">{item.institution}</small>
                </td>
                <td className="num">{inr(item.invested_inr)}</td>
                <td className="num">{inr(item.value_inr)}</td>
              </tr>
            ))}
          </HoldingTable>
        )}
        {holdings.gold.length > 0 && (
          <HoldingTable title="Gold" total={classTotal('gold')} head={['Holding', 'Units', 'Invested', 'Value']}>
            {holdings.gold.map((item) => (
              <tr key={item.name}>
                <td>
                  <strong>{item.name}</strong>
                </td>
                <td className="num">{item.units}</td>
                <td className="num">{inr(item.invested_inr)}</td>
                <td className="num">{inr(item.value_inr)}</td>
              </tr>
            ))}
          </HoldingTable>
        )}
      </div>

      <footer className="assets-footer">
        <p className="muted tiny">
          Linked to PAN {portfolio.pan_masked} ({portfolio.pan_name}) on {shortDate(linkedAt.slice(0, 10))}. Sources: {portfolio.sources.map((item) => item.name).join('; ')}.
        </p>
        <div className="row gap-sm">
          <button className="btn btn-ghost btn-sm" onClick={onRefresh}>
            Refresh
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onUnlink}>
            Unlink PAN
          </button>
        </div>
      </footer>
    </>
  );
}

export function AssetsCard({ onAsk }: { onAsk: (text: string) => void }) {
  const { data, error, loading, reload, setData } = useAsync(() => api.assets());
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  if (loading && !data) {
    return (
      <section className="card">
        <Skeleton lines={5} />
      </section>
    );
  }
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;

  return (
    <div className="assets">
      {data.linked ? (
        <PortfolioView portfolio={data.portfolio} linkedAt={data.linked_at} onAsk={onAsk} onRefresh={reload} onUnlink={() => setConfirmUnlink(true)} />
      ) : (
        <LinkForm panOnFile={data.pan_on_file} onLinked={setData} />
      )}
      {confirmUnlink && (
        <ConfirmDialog
          title="Unlink your PAN?"
          body="Saathi will stop reading your holdings. You can link again at any time."
          confirmLabel="Unlink"
          onCancel={() => setConfirmUnlink(false)}
          onConfirm={async () => {
            setData(await api.unlinkAssets());
            setConfirmUnlink(false);
          }}
        />
      )}
    </div>
  );
}
