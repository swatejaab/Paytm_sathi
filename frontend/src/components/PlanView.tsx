import { useState } from 'react';
import { api } from '../api';
import { dateTime, inr } from '../format';
import type { CaseAction, CaseRecord, Decision, ResolutionOption } from '../types';

type Run = (operation: () => Promise<CaseRecord>) => Promise<void>;

interface Props {
  caseRecord: CaseRecord;
  busy: boolean;
  readOnly: boolean;
  run: Run;
}

function GapMath({ decision }: { decision: Decision }) {
  const calc = decision.calculation;
  if (!calc) return null;
  const coverageFact = decision.facts.find((fact) => fact.name === 'estimated_coverage_inr');
  const billFact = decision.facts.find((fact) => fact.name === 'bill_total_inr');
  return (
    <div className="gap-math">
      <div className="gap-tile">
        <small>Hospital bill</small>
        <strong>{inr(calc.bill_total_inr)}</strong>
        <span>{billFact?.source.ref}</span>
      </div>
      <span className="gap-op">−</span>
      <div className="gap-tile">
        <small>Insurance estimate</small>
        <strong>{inr(calc.coverage_estimate_inr)}</strong>
        <span>{coverageFact?.source.ref}</span>
      </div>
      <span className="gap-op">−</span>
      <div className="gap-tile">
        <small>You can pay now</small>
        <strong>{inr(calc.customer_contribution_inr)}</strong>
        <span>Your profile</span>
      </div>
      <span className="gap-op">=</span>
      <div className="gap-tile gap-result">
        <small>Exact gap</small>
        <strong>{inr(calc.exact_gap_inr)}</strong>
        <span>{decision.formula_version}</span>
      </div>
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="score-bar">
      <span>{label}</span>
      <div className="bar">
        <div style={{ width: `${value}%` }} />
      </div>
      <span className="score-num">{Math.round(value)}</span>
    </div>
  );
}

function OptionCard({
  option,
  canPrepare,
  busy,
  onPrepare,
}: {
  option: ResolutionOption;
  canPrepare: boolean;
  busy: boolean;
  onPrepare: () => void;
}) {
  const [open, setOpen] = useState(option.recommended);
  const blocking = option.guardrails.find((guardrail) => guardrail.blocking && !guardrail.passed);
  return (
    <article className={`option ${option.recommended ? 'option-recommended' : ''} ${option.feasible ? '' : 'option-blocked'}`}>
      <header className="option-head" onClick={() => setOpen(!open)}>
        <div>
          <div className="row gap-sm wrap">
            {option.recommended && <span className="badge badge-green">Recommended</span>}
            {!option.feasible && <span className="badge badge-red">Blocked by guardrail</span>}
            {option.self_serve && <span className="badge">Self-serve</span>}
            <span className={`badge risk-${option.metrics.risk}`}>{option.metrics.risk} risk</span>
          </div>
          <h3>{option.title}</h3>
          <p className="muted">{option.summary}</p>
        </div>
        <div className="option-score" title="Weighted score out of 100">
          <strong>{option.scores.total}</strong>
          <small>/ 100</small>
        </div>
      </header>

      <div className="metrics">
        <div>
          <small>Borrow</small>
          <strong>{option.metrics.borrow_inr ? inr(option.metrics.borrow_inr) : 'None'}</strong>
        </div>
        <div>
          <small>Interest + fees</small>
          <strong>{option.metrics.extra_cost_inr ? inr(option.metrics.extra_cost_inr) : '₹0'}</strong>
        </div>
        <div>
          <small>EMI</small>
          <strong>{option.metrics.monthly_emi_inr ? inr(option.metrics.monthly_emi_inr) : '-'}</strong>
        </div>
        <div>
          <small>Time to funds</small>
          <strong>{option.metrics.time_to_funds_days ? `${option.metrics.time_to_funds_days} day(s)` : 'Today'}</strong>
        </div>
      </div>

      {open && (
        <div className="option-detail">
          <div className="scores">
            <ScoreBar label="Cost" value={option.scores.cost} />
            <ScoreBar label="Risk" value={option.scores.risk} />
            <ScoreBar label="Time" value={option.scores.time} />
            <ScoreBar label="Effort" value={option.scores.effort} />
          </div>
          {option.trade_offs.length > 0 && (
            <ul className="trade-offs">
              {option.trade_offs.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <div className="guardrails">
            {option.guardrails.map((guardrail) => (
              <div key={guardrail.rule} className={`guardrail ${guardrail.passed ? 'pass' : guardrail.blocking ? 'block' : 'warn'}`}>
                <span>{guardrail.passed ? '✓' : guardrail.blocking ? '✕' : '!'}</span>
                <div>
                  <strong>{guardrail.rule}</strong>
                  <small>{guardrail.detail}</small>
                </div>
              </div>
            ))}
          </div>
          {option.steps.length > 0 && (
            <ol className="steps-list">
              {option.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </div>
      )}

      <footer className="option-foot">
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'Hide details' : 'Why this score?'}
        </button>
        {option.self_serve ? (
          <span className="muted small">You can do this yourself. Nothing for Saathi to submit.</span>
        ) : !option.feasible ? (
          <span className="muted small">{blocking?.detail}</span>
        ) : (
          canPrepare && (
            <button className={`btn ${option.recommended ? 'btn-primary' : ''}`} disabled={busy} onClick={onPrepare}>
              {option.handoff ? 'Prepare specialist handoff' : 'Review & approve'}
            </button>
          )
        )}
      </footer>
    </article>
  );
}

function ApprovalPanel({ caseRecord, action, busy, run }: { caseRecord: CaseRecord; action: CaseAction; busy: boolean; run: Run }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="approval card-inset">
      <p className="eyebrow">Approval required</p>
      <h3>{action.title}</h3>
      <p className="muted small">
        Review exactly what Saathi will send. The approval is bound to this payload, so any change needs a fresh approval.
      </p>
      {action.payload.handoff ? (
        <p>Share Resolution Passport {action.payload.passport.passport_id} with a Saathi specialist. No partner action is taken.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Partner (simulated)</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {action.payload.steps.map((step) => (
              <tr key={step.tool}>
                <td>
                  {step.summary}
                  <code className="tool">{step.tool}</code>
                </td>
                <td>{step.partner}</td>
                <td>{step.amount_inr ? inr(step.amount_inr) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {action.payload.kfs?.map((kfs) => (
        <div key={kfs.kfs_id} className="kfs">
          <div className="row space-between wrap">
            <strong>Key Fact Statement: {kfs.product}</strong>
            <small className="muted">
              {kfs.kfs_id} / {kfs.lender}
            </small>
          </div>
          <dl className="kfs-grid">
            <dt>Loan amount</dt>
            <dd>{inr(kfs.principal_inr)}</dd>
            <dt>Interest rate</dt>
            <dd>{kfs.interest_rate_pct}% a year</dd>
            <dt>Approx. APR (incl. fees)</dt>
            <dd>{kfs.approx_apr_pct}%</dd>
            <dt>EMI</dt>
            <dd>
              {inr(kfs.monthly_emi_inr)} x {kfs.tenure_months} months
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
            <dt>Paid to</dt>
            <dd>{kfs.disbursed_to}</dd>
          </dl>
          <small className="muted">
            {kfs.notice} Grievances: {kfs.grievance_contact}. These terms are part of the approval hash below.
          </small>
        </div>
      ))}
      <p className="muted small">
        Includes Resolution Passport {action.payload.passport.passport_id}. Payload hash <code>{action.payload_hash.slice(0, 16)}...</code>
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I approve these exact steps
        and amounts, and consent to sharing my Resolution Passport with the named partners.
      </label>
      <div className="row gap-sm">
        <button
          className="btn btn-primary"
          disabled={!confirmed || busy}
          onClick={() => run(() => api.approveAction(caseRecord.case_id, action.action_id, action.payload_hash))}
        >
          Approve plan
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.cancelAction(caseRecord.case_id, action.action_id))}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ActionProgress({ action }: { action: CaseAction }) {
  if (!action.partner_requests.length) return null;
  return (
    <div className="progress card-inset">
      <div className="row space-between">
        <h3>{action.title}</h3>
        <span className="badge">{action.channel === 'n8n' ? 'via n8n' : 'simulated partner'}</span>
      </div>
      {action.partner_requests.map((request) => (
        <div key={request.tool} className={`partner-request pr-${request.status}`}>
          <div>
            <strong>{request.summary}</strong>
            <small>
              {request.partner} / {request.reference}
            </small>
            {request.updates.length > 1 && <small className="muted">{request.updates.at(-1)?.message}</small>}
          </div>
          <span className={`badge pr-badge-${request.status}`}>{request.status}</span>
        </div>
      ))}
    </div>
  );
}

function BillConfirmation({ caseRecord, busy, readOnly, run }: Props) {
  const question = caseRecord.pending_question;
  const [editing, setEditing] = useState(false);
  const [total, setTotal] = useState(question?.type === 'confirm_bill' ? String(question.total_inr) : '');
  if (!question || question.type !== 'confirm_bill') return null;
  const edited = Number(total.replace(/[^0-9]/g, ''));
  return (
    <div className="card-inset">
      <h3>{question.prompt}</h3>
      <p className="muted small">
        Saathi read {question.document_name} with fixed rules (no AI maths).{' '}
        {question.reconciled ? 'The line items add up to the total.' : 'The line items do not add up to the total; check it carefully.'}
      </p>
      {question.lines.length > 0 && (
        <table className="table">
          <tbody>
            {question.lines.map((line) => (
              <tr key={line.line}>
                <td>{line.description}</td>
                <td className="num">{inr(line.amount_inr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="bill-total">
        <span>Bill total</span>
        {editing ? (
          <input className="input" inputMode="numeric" value={total} onChange={(event) => setTotal(event.target.value)} aria-label="Correct bill total" />
        ) : (
          <strong>{inr(question.total_inr)}</strong>
        )}
      </div>
      {!readOnly && (
        <div className="row gap-sm wrap">
          <button
            className="btn btn-primary"
            disabled={busy || (editing && !edited)}
            onClick={() =>
              run(() => api.confirmBill(caseRecord.case_id, question.document_id, true, editing && edited !== question.total_inr ? edited : undefined))
            }
          >
            {editing ? 'Use this total' : 'Yes, this is correct'}
          </button>
          {!editing && (
            <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
              Correct the total
            </button>
          )}
          <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.confirmBill(caseRecord.case_id, question.document_id, false))}>
            Let a specialist check it
          </button>
        </div>
      )}
    </div>
  );
}

function TransactionPicker({ caseRecord, busy, readOnly, run }: Props) {
  const question = caseRecord.pending_question;
  if (!question || question.type !== 'confirm_transaction') return null;
  return (
    <div className="card-inset">
      <h3>{question.prompt}</h3>
      <p className="muted small">Saathi loaded these from the payments MCP (synthetic). Nothing is filed until you approve.</p>
      <div className="txn-list">
        {question.candidates.map((transaction) => (
          <div key={transaction.transaction_id} className="txn">
            <div>
              <strong>
                {inr(transaction.amount_inr)} to {transaction.counterparty}
              </strong>
              <small>
                {dateTime(transaction.occurred_at)} / {transaction.channel} / {transaction.location}
              </small>
              <div className="row gap-sm wrap">
                <span className={`badge ${transaction.recognized_device ? '' : 'badge-red'}`}>{transaction.device}</span>
                {transaction.first_time_counterparty ? (
                  <span className="badge badge-red">First-time payee</span>
                ) : (
                  <span className="badge">Paid {transaction.prior_payments_to_counterparty} times before</span>
                )}
              </div>
            </div>
            {!readOnly && question.mode === 'select' && (
              <div className="txn-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => run(() => api.confirmTransaction(caseRecord.case_id, transaction.transaction_id, false))}
                >
                  This is the payment
                </button>
              </div>
            )}
            {!readOnly && question.mode !== 'select' && (
              <div className="txn-actions">
                <button
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => run(() => api.confirmTransaction(caseRecord.case_id, transaction.transaction_id, false))}
                >
                  I don't recognize this
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => run(() => api.confirmTransaction(caseRecord.case_id, transaction.transaction_id, true))}
                >
                  This was me
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PlanView({ caseRecord, busy, readOnly, run }: Props) {
  const decision = caseRecord.decision;
  const pendingAction = caseRecord.actions.find((action) => action.status === 'awaiting_approval');
  const liveAction = [...caseRecord.actions].reverse().find((action) => ['in_progress', 'completed', 'failed'].includes(action.status));
  const canPrepare = !readOnly && ['options_ready', 'awaiting_approval'].includes(caseRecord.status);

  if (caseRecord.pending_question?.type === 'confirm_bill') {
    return <BillConfirmation caseRecord={caseRecord} busy={busy} readOnly={readOnly} run={run} />;
  }
  if (caseRecord.pending_question) return <TransactionPicker caseRecord={caseRecord} busy={busy} readOnly={readOnly} run={run} />;

  if (!decision || caseRecord.status === 'intake') {
    return (
      <div className="empty-inline">
        <p className="muted">
          {caseRecord.status === 'intake'
            ? 'Options appear once consent is granted and evidence is gathered.'
            : caseRecord.status === 'resolved'
              ? 'This case is closed.'
              : 'No options yet.'}
        </p>
      </div>
    );
  }

  const transaction = caseRecord.evidence?.transaction;

  return (
    <div className="plan">
      <p className="eyebrow">Here's your clear path</p>
      <GapMath decision={decision} />
      {transaction && (
        <div className="txn-summary">
          <strong>
            {inr(transaction.amount_inr)} to {transaction.counterparty}
          </strong>
          <small>
            {dateTime(transaction.occurred_at)} / {transaction.device} / {transaction.location}
          </small>
        </div>
      )}

      {decision.requires_verification && (
        <p className="alert alert-warn">
          <strong>Confidence gate:</strong> automated claim and credit steps are paused until a specialist verifies the evidence.
        </p>
      )}
      {decision.warnings.map((warning) => (
        <p key={warning} className="alert alert-warn">
          {warning}
        </p>
      ))}

      <div className="explanation">
        <span aria-hidden>💡</span>
        <p>{decision.explanation}</p>
      </div>

      {liveAction && <ActionProgress action={liveAction} />}
      {pendingAction && !readOnly && <ApprovalPanel caseRecord={caseRecord} action={pendingAction} busy={busy} run={run} />}

      <div className="options">
        {decision.options.map((option) => (
          <OptionCard
            key={option.option_id}
            option={option}
            busy={busy}
            canPrepare={canPrepare && pendingAction?.option_id !== option.option_id}
            onPrepare={() => run(() => api.prepareAction(caseRecord.case_id, option.option_id))}
          />
        ))}
      </div>
      <p className="muted small">
        Ranking weights: cost {Math.round(decision.weights.cost * 100)}% / risk {Math.round(decision.weights.risk * 100)}% / time{' '}
        {Math.round(decision.weights.time * 100)}% / effort {Math.round(decision.weights.effort * 100)}%. Commission is never an
        input. Formula{' '}
        {decision.formula_version}.
      </p>
    </div>
  );
}
