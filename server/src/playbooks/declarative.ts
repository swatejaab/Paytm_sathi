import { settings } from '../config';
import { explainOptions, formatInr, humanSupportDraft, rankOptions, SCORE_WEIGHTS, type OptionDraft } from '../decision';
import type { Decision, Fact, Guardrail, RiskLevel, SourceRef, Urgency } from '../types';
import { evaluate, renderTemplate, resolveInputValue, type Scope } from './expressions';
import type { DeclarativeOption, PlaybookDefinition } from './registry';

// Deterministic decision for a declarative playbook: evaluate its facts, guards, and options
// with the safe expression language, then rank them with the same scorer as every other journey.
export function runDeclarativeDecision(
  playbook: PlaybookDefinition,
  input: { caseId: string; urgency: Urgency; context: Scope; partner: string },
): Decision {
  const rules = playbook.rules!;
  const scope: Scope = { ...input.context, today: settings.demoDate };
  const facts: Fact[] = [];

  for (const definition of rules.facts) {
    const value = evaluate(definition.expr, scope);
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
      throw new Error(`Fact ${definition.name} has no value.`);
    }
    scope[definition.name] = value;
    const transactionId = (input.context.transaction as { transaction_id?: string } | undefined)?.transaction_id ?? 'transaction';
    const source: SourceRef =
      definition.source === 'transaction'
        ? { type: 'transaction', ref: transactionId, document: input.partner }
        : definition.source === 'regulation'
          ? { type: 'regulation', ref: definition.ref ?? 'Regulation' }
          : definition.source === 'customer_profile'
            ? { type: 'customer_profile', ref: definition.ref ?? 'Customer profile' }
            : { type: 'calculation', ref: `${definition.expr} (${rules.version})` };
    facts.push({
      name: definition.name,
      label: definition.label,
      value,
      unit: definition.unit ?? null,
      source,
      confidence: definition.source === 'calculation' ? 0.99 : 0.95,
    });
  }

  const drafts: OptionDraft[] = (playbook.options ?? []).map((option): OptionDraft => {
    if ('specialist' in option) return humanSupportDraft(option.urgency ?? input.urgency);
    return buildOption(option, scope, input.caseId, input.partner);
  });
  const options = rankOptions(drafts);
  const recommended = options.find((option) => option.recommended);
  const amountFact = facts.find((fact) => fact.unit === 'INR');
  return {
    formula_version: rules.version,
    computed_at: new Date().toISOString(),
    event_type: playbook.event_type,
    calculation: null,
    facts,
    options,
    recommended_option_id: recommended?.option_id ?? null,
    explanation: `${playbook.title}${amountFact ? ` (${formatInr(Number(amountFact.value))})` : ''}. ${explainOptions(options)}`,
    warnings: [],
    requires_verification: false,
    commission_considered: false,
    weights: { ...SCORE_WEIGHTS },
  };
}

function buildOption(option: DeclarativeOption, scope: Scope, caseId: string, partner: string): OptionDraft {
  const guardrails: Guardrail[] = option.guards.map((guard) => {
    const passed = Boolean(evaluate(guard.expr, scope));
    return { rule: guard.rule, passed, blocking: guard.blocking, detail: renderTemplate(passed ? guard.pass : guard.fail, scope) };
  });
  const risk: RiskLevel =
    typeof option.metrics.risk === 'string'
      ? option.metrics.risk
      : evaluate(option.metrics.risk.expr, scope)
        ? option.metrics.risk.true
        : option.metrics.risk.false;
  const extraCost =
    typeof option.metrics.extra_cost_inr === 'number' ? option.metrics.extra_cost_inr : Number(evaluate(option.metrics.extra_cost_inr, scope));

  return {
    option_id: option.id,
    title: renderTemplate(option.title, scope),
    summary: renderTemplate(option.summary, scope),
    steps: option.steps.map((step) => renderTemplate(step, scope)),
    metrics: {
      borrow_inr: 0,
      extra_cost_inr: extraCost,
      monthly_emi_inr: 0,
      time_to_funds_days: option.metrics.time_to_funds_days,
      effort_steps: option.metrics.effort_steps,
      risk,
    },
    guardrails,
    trade_offs: option.trade_offs.map((line) => renderTemplate(line, scope)),
    writes: option.writes.map((write) => ({
      tool: write.tool,
      partner,
      amount_inr: Number(evaluate(write.amount, scope)),
      summary: renderTemplate(write.summary, scope),
      input: {
        case_id: caseId,
        ...Object.fromEntries(Object.entries(write.input).map(([key, value]) => [key, resolveInputValue(value, scope)])),
      },
    })),
    handoff: false,
    self_serve: option.self_serve,
  };
}
