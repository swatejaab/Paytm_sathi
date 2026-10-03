import { describeSource, factValue, inr } from '../format';
import type { Decision, ResolutionOption } from '../types';

export const LOW_CONFIDENCE = 0.75;
const pct = (weight: number) => `${Math.round(weight * 100)}%`;

function whyNot(option: ResolutionOption, best: ResolutionOption): string {
  const blocking = option.guardrails.find((guardrail) => guardrail.blocking && !guardrail.passed);
  if (blocking) return blocking.detail;
  const gaps = (['cost', 'risk', 'time', 'effort'] as const)
    .filter((key) => option.scores[key] + 5 < best.scores[key])
    .map((key) => ({ cost: 'costs more', risk: 'carries more risk', time: 'takes longer', effort: 'needs more steps' })[key]);
  if (gaps.length) return `Compared with the recommendation it ${gaps.join(', ')}.`;
  return option.trade_offs[0] ?? 'Scored slightly lower overall.';
}

export function WhyPlan({ decision }: { decision: Decision }) {
  const best = decision.options.find((option) => option.option_id === decision.recommended_option_id) ?? decision.options[0];
  if (!best) return <p className="muted">Saathi hasn't compared any options yet.</p>;
  const alternatives = decision.options.filter((option) => option.option_id !== best.option_id);
  const inputs = decision.facts.filter((fact) => fact.source.type !== 'calculation');
  const calculated = decision.facts.filter((fact) => fact.source.type === 'calculation');
  const risks = [
    ...decision.warnings,
    ...best.guardrails.filter((guardrail) => !guardrail.passed).map((guardrail) => `${guardrail.rule}: ${guardrail.detail}`),
    ...best.trade_offs,
  ];

  return (
    <div className="why-plan">
      <section>
        <h3>Recommendation</h3>
        <p>
          <strong>{best.title}.</strong> {best.summary}
        </p>
        <p className="muted">{decision.explanation}</p>
      </section>

      <section>
        <h3>Information used</h3>
        <ul className="fact-list">
          {inputs.map((fact, index) => (
            <li key={`${fact.name}-${index}`}>
              <div>
                <span>{fact.label}</span>
                <small className="muted">{describeSource(fact.source)}</small>
                {fact.confidence < LOW_CONFIDENCE && (
                  <small className="low-confidence">I couldn't confidently determine this. Please confirm it before relying on the plan.</small>
                )}
              </div>
              <strong>{factValue(fact)}</strong>
            </li>
          ))}
        </ul>
      </section>

      {(decision.calculation || calculated.length > 0) && (
        <section>
          <h3>Calculation</h3>
          {decision.calculation ? (
            <div className="calc">
              <div>
                <span>Hospital bill</span>
                <strong>{inr(decision.calculation.bill_total_inr)}</strong>
              </div>
              <div>
                <span>− Insurance cover</span>
                <strong>{inr(decision.calculation.coverage_estimate_inr)}</strong>
              </div>
              <div>
                <span>− You can pay now</span>
                <strong>{inr(decision.calculation.customer_contribution_inr)}</strong>
              </div>
              <div className="calc-total">
                <span>= Funding gap</span>
                <strong>{inr(decision.calculation.exact_gap_inr)}</strong>
              </div>
              <small className="muted">Funding gap = max(bill − insurance − what you can pay, 0)</small>
            </div>
          ) : (
            <ul className="fact-list">
              {calculated.map((fact) => (
                <li key={fact.name}>
                  <div>
                    <span>{fact.label}</span>
                    <small className="muted">{fact.source.ref}</small>
                  </div>
                  <strong>{factValue(fact)}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {alternatives.length > 0 && (
        <section>
          <h3>Alternatives considered</h3>
          <ul className="alt-list">
            {alternatives.map((option) => (
              <li key={option.option_id}>
                <div className="row space-between">
                  <strong>{option.title}</strong>
                  <span className="muted small">{option.scores.total} / 100</span>
                </div>
                <small className="muted">{whyNot(option, best)}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Why this one</h3>
        <p>
          {`It scored ${best.scores.total} out of 100, the best balance of cost (${best.scores.cost}), risk (${best.scores.risk}), time (${best.scores.time}) and effort (${best.scores.effort}) among the options that pass every safety check.`}
        </p>
      </section>

      {risks.length > 0 && (
        <section>
          <h3>Risks and things to check</h3>
          <ul className="bullets">
            {risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </section>
      )}

      <p className="note">
        {`Options are ranked only on cost (${pct(decision.weights.cost)}), risk (${pct(decision.weights.risk)}), time (${pct(decision.weights.time)}) and effort (${pct(decision.weights.effort)}). Partner commission is never considered. Nothing happens until you approve it.`}
      </p>
    </div>
  );
}
