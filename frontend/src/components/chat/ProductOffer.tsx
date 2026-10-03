import { useState } from 'react';
import { api, errorMessage } from '../../api';
import { inr } from '../../format';
import type { CaseAction, CaseRecord, SuggestedProduct } from '../../types';
import { Icon } from '../Icon';
import type { Run } from '../PlanView';
import { Modal, useAsync } from '../ui';

const PRODUCT_TOOLS = new Set(['lending.submit_application', 'insurer.apply_term_plan']);

// True when Saathi's recommended option for this case includes applying for a loan or buying a policy.
export function recommendsProduct(record: CaseRecord): boolean {
  const decision = record.decision;
  const best = decision?.options.find((option) => option.option_id === decision.recommended_option_id);
  return Boolean(best && best.feasible && !best.handoff && best.writes.some((write) => PRODUCT_TOOLS.has(write.tool)));
}

const headline = (product: SuggestedProduct) =>
  product.kind === 'loan' ? `${product.product} of ${inr(product.amount_inr)}` : `Term life cover of ${inr(product.sum_assured_inr)}`;

function KeyFacts({ product }: { product: SuggestedProduct }) {
  return product.kind === 'loan' ? (
    <dl className="product-facts">
      <div>
        <dt>EMI</dt>
        <dd>
          {inr(product.monthly_emi_inr)} × {product.tenure_months}
        </dd>
      </div>
      <div>
        <dt>Interest</dt>
        <dd>{product.interest_rate_pct}% a year</dd>
      </div>
      <div>
        <dt>Total you repay</dt>
        <dd>{inr(product.total_payable_inr)}</dd>
      </div>
      <div>
        <dt>Paid to</dt>
        <dd>{product.disburse_to === 'hospital' ? 'The hospital' : 'Your account'}</dd>
      </div>
    </dl>
  ) : (
    <dl className="product-facts">
      <div>
        <dt>Cover</dt>
        <dd>{inr(product.sum_assured_inr)}</dd>
      </div>
      <div>
        <dt>Premium</dt>
        <dd>{inr(product.annual_premium_inr)} a year</dd>
      </div>
      <div>
        <dt>About</dt>
        <dd>{inr(product.monthly_equivalent_inr)} a month</dd>
      </div>
      <div>
        <dt>Term</dt>
        <dd>
          {product.term_years} years{product.cover_until_age ? ` (to age ${product.cover_until_age})` : ''}
        </dd>
      </div>
    </dl>
  );
}

function ApplyModal({ product, record, run, onClose }: { product: SuggestedProduct; record: CaseRecord; run: Run; onClose: () => void }) {
  const isLoan = product.kind === 'loan';
  const existing = record.actions.find((action) => action.option_id === product.option_id && action.status === 'awaiting_approval') ?? null;
  const [action, setAction] = useState<CaseAction | null>(existing);
  const [step, setStep] = useState<'review' | 'confirm' | 'done'>(existing ? 'confirm' : 'review');
  const [understood, setUnderstood] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.prepareAction(record.case_id, product.option_id);
      await run(async () => updated);
      setAction([...updated.actions].reverse().find((candidate) => candidate.option_id === product.option_id && candidate.status === 'awaiting_approval') ?? null);
      setStep('confirm');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.approveAction(record.case_id, action.action_id, action.payload_hash);
      await run(async () => updated);
      const submitted = updated.actions.find((candidate) => candidate.action_id === action.action_id);
      const tool = isLoan ? 'lending.submit_application' : 'insurer.apply_term_plan';
      setReference(submitted?.partner_requests.find((request) => request.tool === tool)?.reference ?? null);
      setStep('done');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const kfs = action?.payload.kfs?.[0];
  const title = isLoan ? 'Apply for this loan' : 'Buy this policy';

  return (
    <Modal
      title={step === 'done' ? (isLoan ? 'Application submitted' : 'Proposal submitted') : title}
      onClose={onClose}
      footer={
        step === 'done' ? (
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        ) : step === 'review' ? (
          <>
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Not now
            </button>
            <button className="btn btn-primary" onClick={() => void prepare()} disabled={!understood || busy}>
              {busy ? 'Preparing…' : isLoan ? 'See the Key Fact Statement' : 'Review the proposal'}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Not now
            </button>
            <button className="btn btn-primary" onClick={() => void approve()} disabled={!agreed || !action || busy}>
              {busy ? 'Submitting…' : isLoan ? 'Apply now' : 'Buy policy'}
            </button>
          </>
        )
      }
    >
      {step === 'done' ? (
        <div className="apply-done">
          <span className="apply-done-icon">
            <Icon name="check" size={28} />
          </span>
          <p>
            {isLoan
              ? `Your application for ${inr(product.kind === 'loan' ? product.amount_inr : 0)} went to ${product.partner}.`
              : `Your proposal for ${inr(product.kind === 'insurance' ? product.sum_assured_inr : 0)} of cover went to ${product.partner}.`}{' '}
            {reference && (
              <>
                Reference <strong>{reference}</strong>.
              </>
            )}
          </p>
          <p className="muted small">
            {isLoan
              ? 'The lender makes the final credit decision. You can cancel within the cooling-off period without a penalty.'
              : 'The insurer underwrites the proposal and may ask for medical details before the policy is issued.'}{' '}
            Track progress in the plan timeline. This demo uses simulated partners.
          </p>
        </div>
      ) : step === 'review' ? (
        <div className="apply-body">
          <div className="apply-product">
            <small className="muted">{product.partner}</small>
            <h3>{headline(product)}</h3>
          </div>
          <KeyFacts product={product} />
          <div className="apply-why">
            <Icon name="sparkle" size={16} />
            <span>
              <strong>Why Saathi suggests this:</strong> {product.why}
            </span>
          </div>
          {product.other_steps.length > 0 && (
            <div className="small">
              <strong>Your plan also includes</strong>
              <ul className="bullets">
                {product.other_steps.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
            {isLoan
              ? 'I understand this is a loan I must repay, and I want to see the full Key Fact Statement before applying.'
              : 'I understand this is an insurance purchase with a yearly premium, and I want to review the proposal before buying.'}
          </label>
          {error && <p className="alert alert-error small">{error}</p>}
        </div>
      ) : (
        <div className="apply-body">
          {kfs ? (
            <dl className="kfs-grid">
              <dt>Lender</dt>
              <dd>{kfs.lender}</dd>
              <dt>Loan amount</dt>
              <dd>{inr(kfs.principal_inr)}</dd>
              <dt>Interest rate</dt>
              <dd>{kfs.interest_rate_pct}% a year</dd>
              <dt>Approx. APR (incl. fees)</dt>
              <dd>{kfs.approx_apr_pct}%</dd>
              <dt>EMI</dt>
              <dd>
                {inr(kfs.monthly_emi_inr)} × {kfs.tenure_months} months
              </dd>
              <dt>Interest + processing fee</dt>
              <dd>
                {inr(kfs.total_interest_inr)} + {inr(kfs.processing_fee_inr)}
              </dd>
              <dt>Total you repay</dt>
              <dd>
                <strong>{inr(kfs.total_payable_inr)}</strong>
              </dd>
              <dt>Cooling-off period</dt>
              <dd>{kfs.cooling_off_days} days to exit without penalty</dd>
            </dl>
          ) : product.kind === 'insurance' ? (
            <dl className="kfs-grid">
              <dt>Insurer</dt>
              <dd>{product.partner}</dd>
              <dt>Plan</dt>
              <dd>Term life, level cover</dd>
              <dt>Sum assured</dt>
              <dd>{inr(product.sum_assured_inr)}</dd>
              <dt>Policy term</dt>
              <dd>{product.term_years} years</dd>
              <dt>Yearly premium</dt>
              <dd>
                <strong>{inr(product.annual_premium_inr)}</strong>
              </dd>
              <dt>Free-look period</dt>
              <dd>30 days to cancel for a refund</dd>
            </dl>
          ) : null}
          {action && action.payload.steps.length > 1 && (
            <div className="small">
              <strong>Approving submits all {action.payload.steps.length} steps of your plan:</strong>
              <ul className="bullets">
                {action.payload.steps.map((item) => (
                  <li key={item.tool}>{item.summary}</li>
                ))}
              </ul>
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
            {isLoan
              ? 'I have read the Key Fact Statement and I want to apply. I consent to sharing my Resolution Passport with the lender.'
              : 'I want to buy this policy at this premium. I consent to sharing my Resolution Passport with the insurer.'}
          </label>
          <small className="muted">Approval reference {action?.payload_hash.slice(0, 10).toUpperCase()}. Nothing is sent until you approve.</small>
          {error && <p className="alert alert-error small">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

export function ProductOffer({ record, run }: { record: CaseRecord; run: Run }) {
  const { data: product } = useAsync(() => api.product(record.case_id), [record.case_id, record.decision?.computed_at]);
  const [open, setOpen] = useState(false);
  if (!product) return null;
  const isLoan = product.kind === 'loan';
  const submitted = record.actions.find(
    (action) => action.option_id === product.option_id && ['approved', 'in_progress', 'completed'].includes(action.status),
  );
  const reference = submitted?.partner_requests.find((request) => request.tool === (isLoan ? 'lending.submit_application' : 'insurer.apply_term_plan'))?.reference;

  return (
    <div className={`product-offer ${isLoan ? 'is-loan' : 'is-insurance'}`}>
      <div className="product-head">
        <span className="product-icon">
          <Icon name={isLoan ? 'rupee' : 'shield'} size={20} />
        </span>
        <div>
          <small>{isLoan ? 'Saathi suggests this loan' : 'Saathi suggests this policy'}</small>
          <strong>{headline(product)}</strong>
          <small className="muted">{product.partner}</small>
        </div>
      </div>
      <KeyFacts product={product} />
      {submitted ? (
        <p className="product-status">
          <Icon name="check" size={16} /> {isLoan ? 'Application submitted' : 'Proposal submitted'}
          {reference ? ` · ${reference}` : ''}
        </p>
      ) : (
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          {isLoan ? 'Apply for loan' : 'Buy policy'}
        </button>
      )}
      <small className="muted tiny">Shown because it is part of your recommended plan. Options are ranked on cost, risk and time; partner commission is never considered.</small>
      {open && <ApplyModal product={product} record={record} run={run} onClose={() => setOpen(false)} />}
    </div>
  );
}
