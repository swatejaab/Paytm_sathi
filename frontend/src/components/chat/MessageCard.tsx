import { GOAL_LABELS, inr, shortDate } from '../../format';
import type { AffordabilityAssessment, CaseRecord, ChatCard, GoalDraft, GoalImpact, GoalType } from '../../types';
import type { PanelTab } from '../CasePanel';
import { Icon } from '../Icon';
import { BillConfirmation, TransactionPicker, TransactionSummary, type Run } from '../PlanView';

interface Props {
  card: ChatCard;
  record: CaseRecord;
  busy: boolean;
  run: Run;
  onOpenPlan: (tab: PanelTab) => void;
  onApprove?: (optionId: string) => void;
  approveState?: ApproveState;
}

function GapCard({ card }: { card: Extract<ChatCard, { type: 'gap' }> }) {
  return (
    <div className="chat-card gap-card">
      <p className="card-title">Funding gap</p>
      <ul className="gap-lines">
        {card.lines.map((line) => (
          <li key={line.label} className={line.op === '=' ? 'gap-total' : ''}>
            <span>
              {line.op === '-' ? '− ' : line.op === '=' ? '= ' : ''}
              {line.label}
              {line.op !== '=' && <small className="muted">{line.source}</small>}
            </span>
            <strong>{inr(line.amount_inr)}</strong>
          </li>
        ))}
      </ul>
      <small className="muted">{card.formula}</small>
    </div>
  );
}

function GapTiles({ record }: { record: CaseRecord }) {
  const calculation = record.decision?.calculation;
  if (!calculation) return null;
  const coverFact = record.decision!.facts.find((fact) => fact.name === 'estimated_coverage_inr');
  const cashless = Boolean(record.context?.records?.admission?.cashless) && coverFact?.source.type === 'policy_clause';
  const tiles = [
    { label: 'Hospital bill', value: calculation.bill_total_inr },
    ...(calculation.coverage_estimate_inr > 0 ? [{ label: cashless ? 'Cashless covers' : 'Insurance covers', value: calculation.coverage_estimate_inr }] : []),
    { label: 'You pay now', value: calculation.customer_contribution_inr },
  ];
  return (
    <div className="gap-tiles">
      {tiles.map((tile) => (
        <span key={tile.label}>
          <small>{tile.label}</small>
          {inr(tile.value)}
        </span>
      ))}
      <span className="gap-tile-total">
        <small>Real gap</small>
        {inr(calculation.exact_gap_inr)}
      </span>
    </div>
  );
}

type ApproveState = 'loading' | 'done' | 'error' | undefined;

function PlanCard({
  record,
  onOpenPlan,
  onApprove,
  approveState,
}: {
  record: CaseRecord;
  onOpenPlan: (tab: PanelTab) => void;
  onApprove?: (optionId: string) => void;
  approveState: ApproveState;
}) {
  const decision = record.decision;
  if (!decision) return null;
  const best = decision.options.find((option) => option.option_id === decision.recommended_option_id);
  const pending = record.actions.find((action) => action.status === 'awaiting_approval');
  const live = [...record.actions].reverse().find((action) => ['approved', 'in_progress', 'completed'].includes(action.status));
  const hospital = decision.event_type === 'hospitalization' && decision.calculation;
  const lessBorrowed = best?.trade_offs.find((tradeOff) => /less borrowed/.test(tradeOff));
  const canApprove = Boolean(onApprove && best && best.feasible && !best.handoff && best.writes.length > 0 && !pending && !live);
  const flags = hospital ? decision.warnings.slice(0, 3) : [];
  return (
    <div className="chat-card plan-card">
      <p className="card-title">
        <Icon name="sparkle" size={16} /> Recommended next step
      </p>
      {hospital && <GapTiles record={record} />}
      {best ? (
        <>
          <h4>{best.title}</h4>
          <p className="small">{best.summary}</p>
          {lessBorrowed && (
            <p className="plan-highlight small">
              <Icon name="check" size={16} /> {lessBorrowed}
            </p>
          )}
          <div className="plan-metrics">
            {best.metrics.borrow_inr > 0 && (
              <span>
                <small>Borrow</small>
                {inr(best.metrics.borrow_inr)}
              </span>
            )}
            <span>
              <small>Extra cost</small>
              {best.metrics.extra_cost_inr ? inr(best.metrics.extra_cost_inr) : '₹0'}
            </span>
            {best.metrics.monthly_emi_inr > 0 && (
              <span>
                <small>EMI</small>
                {inr(best.metrics.monthly_emi_inr)}
              </span>
            )}
            <span>
              <small>Risk</small>
              {best.metrics.risk}
            </span>
          </div>
        </>
      ) : (
        <p className="small">No option passed every safety check, so a specialist is the safest next step.</p>
      )}
      {flags.length > 0 && (
        <ul className="plan-flags small">
          {flags.map((flag) => (
            <li key={flag}>
              <Icon name="alert" size={14} />
              <span>{flag}</span>
            </li>
          ))}
        </ul>
      )}
      {pending && (
        <p className="alert alert-info small">
          <strong>{pending.title}</strong> is ready for your approval. Nothing is sent until you approve it.
        </p>
      )}
      {live && (
        <p className="small muted">
          {live.title}: {live.status === 'completed' ? 'completed' : 'in progress'} (simulated partner response).
        </p>
      )}
      <div className="row gap-sm wrap">
        {canApprove ? (
          <>
            <button className="btn btn-sm btn-primary" disabled={approveState === 'loading'} onClick={() => onApprove!(best!.option_id)}>
              {approveState === 'loading' ? <span className="spinner spinner-sm" aria-hidden /> : <Icon name="check" size={16} />} Approve plan
            </button>
            <button className="btn btn-sm" onClick={() => onOpenPlan('plan')}>
              Compare {decision.options.length} options
            </button>
          </>
        ) : (
          <button className="btn btn-sm btn-primary" onClick={() => onOpenPlan('plan')}>
            {pending ? 'Review & approve' : `Compare ${decision.options.length} option${decision.options.length === 1 ? '' : 's'}`}
          </button>
        )}
        <button className="btn btn-sm" onClick={() => onOpenPlan('why')}>
          Why this plan?
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => onOpenPlan('evidence')}>
          Sources
        </button>
      </div>
    </div>
  );
}

const SCENARIO_STATUS: Record<string, { label: string; className: string }> = {
  comfortable: { label: 'Comfortable', className: 'badge-green' },
  manageable: { label: 'Manageable', className: 'badge-amber' },
  high_stress: { label: 'High stress', className: 'badge-red' },
  not_possible: { label: 'Not possible', className: 'badge-red' },
  wait: { label: 'Strongest position', className: 'badge-blue' },
};

function AffordCardView({ assessment }: { assessment: AffordabilityAssessment & { goal_impact?: GoalImpact | null } }) {
  const verdict = assessment.verdict === 'yes' ? 'Yes' : assessment.verdict === 'yes_with_plan' ? 'Yes, with a plan' : 'Not right now';
  return (
    <div className="chat-card afford-card">
      <p className="card-title">
        {assessment.item}: {inr(assessment.amount_inr)}
      </p>
      <p className={`verdict verdict-${assessment.verdict}`}>
        <strong>{verdict}.</strong> {assessment.headline}
      </p>
      {assessment.warning && <p className="alert alert-warn small">{assessment.warning}</p>}
      <ul className="scenario-list">
        {assessment.scenarios.map((scenario) => (
          <li key={scenario.id} className={scenario.id === assessment.recommended_id ? 'suggested' : ''}>
            <div className="row space-between gap-sm">
              <strong>{scenario.title}</strong>
              <span className={`badge ${SCENARIO_STATUS[scenario.status]?.className ?? ''}`}>{SCENARIO_STATUS[scenario.status]?.label ?? scenario.status}</span>
            </div>
            <small className="muted">
              {scenario.upfront_inr ? `${inr(scenario.upfront_inr)} upfront` : ''}
              {scenario.monthly_emi_inr ? `${scenario.upfront_inr ? ' · ' : ''}${inr(scenario.monthly_emi_inr)} × ${scenario.months} months` : ''}
              {scenario.extra_cost_inr ? ` · ${inr(scenario.extra_cost_inr)} extra` : ''}
            </small>
            <small>{scenario.effect}</small>
          </li>
        ))}
      </ul>
      {assessment.goal_impact && (
        <div className="goal-impact">
          <Icon name="target" size={16} />
          <span>{assessment.goal_impact.summary}</span>
        </div>
      )}
      <small className="muted">
        Based on {inr(assessment.context.free_cash_monthly_inr)} free cash a month and {inr(assessment.context.spare_savings_inr)} of savings above
        your emergency buffer. You decide; Saathi explains the trade-offs.
      </small>
    </div>
  );
}

function GoalDraftCard({ goal, required, months }: { goal: GoalDraft; required: number | null; months: number | null }) {
  const remaining = Math.max(goal.target_inr - goal.current_savings_inr, 0);
  return (
    <div className="chat-card goal-card">
      <p className="card-title">
        <Icon name="target" size={16} /> Goal preview
      </p>
      <h4>{goal.name}</h4>
      <dl className="kv small">
        <dt>Type</dt>
        <dd>{GOAL_LABELS[goal.type as GoalType] ?? goal.type}</dd>
        <dt>Target</dt>
        <dd>{inr(goal.target_inr)}</dd>
        <dt>Target date</dt>
        <dd>{goal.target_date ? shortDate(goal.target_date) : 'Not set'}</dd>
        <dt>Saved so far</dt>
        <dd>{inr(goal.current_savings_inr)}</dd>
        <dt>Still needed</dt>
        <dd>{inr(remaining)}</dd>
        {required !== null && (
          <>
            <dt>Save each month</dt>
            <dd>
              <strong>{inr(required)}</strong>
              {months ? ` for ${months} months` : ''}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function MessageCard({ card, record, busy, run, onOpenPlan, onApprove, approveState }: Props) {
  switch (card.type) {
    case 'gap':
      return <GapCard card={card} />;
    case 'plan':
      return <PlanCard record={record} onOpenPlan={onOpenPlan} onApprove={onApprove} approveState={approveState} />;
    case 'transactions':
      if (record.pending_question?.type === 'confirm_transaction') {
        return (
          <div className="chat-card">
            <TransactionPicker caseRecord={record} busy={busy} readOnly={false} run={run} />
          </div>
        );
      }
      return record.evidence?.transaction ? (
        <div className="chat-card">
          <TransactionSummary transaction={record.evidence.transaction} />
        </div>
      ) : null;
    case 'bill_confirmation':
      if (record.pending_question?.type === 'confirm_bill') {
        return (
          <div className="chat-card">
            <BillConfirmation caseRecord={record} busy={busy} readOnly={false} run={run} />
          </div>
        );
      }
      return record.confirmed_bill ? (
        <div className="chat-card">
          <p className="small">
            <Icon name="check" size={16} /> Bill total confirmed: <strong>{inr(record.confirmed_bill.total_inr)}</strong> from {record.confirmed_bill.document_name}
          </p>
        </div>
      ) : null;
    case 'afford':
      return <AffordCardView assessment={card.assessment} />;
    case 'goal_draft':
      return <GoalDraftCard goal={card.goal} required={card.required_monthly_inr} months={card.months_left} />;
    default:
      return null;
  }
}
