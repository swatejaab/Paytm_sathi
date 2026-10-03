import crypto from 'node:crypto';
import { traceStandalone } from './agent/trace';
import { signApprovalToken } from './auth';
import { addMessage, addTimeline, hasConsent, loadCaseForOwner, newId, supersedePendingActions } from './caseStore';
import { nowIso, recordAudit, updateCase } from './db';
import { formatInr } from './decision';
import { HttpError } from './errors';
import { hashPayload } from './hashing';
import { invokeTool } from './mcp/gateway';
import { dispatchApprovedAction } from './partners';
import { buildPassport } from './passport';
import type { ActionPayload, CaseAction, CaseRecord, Principal } from './types';

const PREPARABLE_STATUSES = new Set(['options_ready', 'awaiting_approval']);

function findAction(record: CaseRecord, actionId: string): CaseAction {
  const action = record.actions.find((candidate) => candidate.action_id === actionId);
  if (!action) throw new HttpError(404, 'Action not found');
  return action;
}

export async function prepareAction(principal: Principal, caseId: string, optionId: string): Promise<CaseRecord> {
  const record = loadCaseForOwner(principal, caseId, 'action:approve');
  if (!PREPARABLE_STATUSES.has(record.status)) {
    throw new HttpError(409, `Actions can be prepared only when options are ready (current status: ${record.status}).`);
  }
  if (!hasConsent(record, 'prepare_resolution_options')) throw new HttpError(403, 'Grant consent before preparing an action.');
  const option = record.decision?.options.find((candidate) => candidate.option_id === optionId);
  if (!option) throw new HttpError(404, 'Option not found');
  if (!option.feasible) {
    const blocked = option.guardrails.find((guardrail) => guardrail.blocking && !guardrail.passed);
    throw new HttpError(422, `This option is blocked by a guardrail: ${blocked?.detail ?? 'not feasible'}`);
  }
  if (option.self_serve) throw new HttpError(422, 'This is a self-serve option; there is nothing for Saathi to submit.');

  supersedePendingActions(record, 'You chose a different option.');
  const payload: ActionPayload = {
    case_id: record.case_id,
    option_id: option.option_id,
    option_title: option.title,
    formula_version: record.decision!.formula_version,
    prepared_for: principal.sub,
    steps: option.writes.map((write) => ({ ...write, input: { case_id: record.case_id, ...write.input } })),
    handoff: option.handoff,
    passport: buildPassport(record),
  };
  // Credit steps carry the lender's Key Fact Statement, so the approval hash covers the exact terms shown.
  for (const step of payload.steps.filter((candidate) => candidate.tool === 'lending.submit_application')) {
    const kfs = await invokeTool<Record<string, unknown>>(
      'lending.get_kfs',
      { case_id: record.case_id, offer_id: step.input.offer_id, amount_inr: step.input.amount_inr },
      { principal, caseRecord: record },
    );
    payload.kfs = [...(payload.kfs ?? []), kfs];
  }
  const action: CaseAction = {
    action_id: newId('ACT'),
    option_id: option.option_id,
    title: option.title,
    status: 'awaiting_approval',
    payload,
    payload_hash: hashPayload(payload),
    idempotency_key: crypto.randomUUID(),
    channel: null,
    created_at: nowIso(),
    approved_at: null,
    approved_by: null,
    partner_requests: [],
  };
  record.actions.push(action);
  addTimeline(record, {
    status: 'awaiting_approval',
    title: `Prepared: ${option.title}`,
    detail: option.handoff
      ? 'Waiting for your approval to share the Resolution Passport with a specialist.'
      : `Waiting for your approval of ${payload.steps.length} partner step(s).`,
    actor: 'saathi',
  });
  traceStandalone(
    record,
    'action_prepared',
    'action_preparer',
    `Prepared ${payload.steps.length} step(s) for "${option.title}"; payload ${action.payload_hash.slice(0, 12)} awaits approval.`,
  );
  recordAudit({
    case_id: record.case_id,
    actor: principal.sub,
    event: 'action_prepared',
    detail: { action_id: action.action_id, option_id: option.option_id, payload_hash: action.payload_hash },
  });
  updateCase(record);
  return record;
}

export function cancelAction(principal: Principal, caseId: string, actionId: string): CaseRecord {
  const record = loadCaseForOwner(principal, caseId, 'action:approve');
  const action = findAction(record, actionId);
  if (action.status !== 'awaiting_approval') throw new HttpError(409, 'Only actions awaiting approval can be cancelled.');
  action.status = 'cancelled';
  addTimeline(record, { status: 'options_ready', title: `Cancelled: ${action.title}`, detail: 'Nothing was submitted.', actor: 'customer' });
  recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'action_cancelled', detail: { action_id: actionId } });
  updateCase(record);
  return record;
}

export async function approveAction(
  principal: Principal,
  caseId: string,
  actionId: string,
  payloadHash: string,
): Promise<CaseRecord> {
  const record = loadCaseForOwner(principal, caseId, 'action:approve');
  const action = findAction(record, actionId);
  if (action.status !== 'awaiting_approval') throw new HttpError(409, `This action is ${action.status}; it cannot be approved.`);
  if (!hasConsent(record, 'prepare_resolution_options')) throw new HttpError(403, 'Consent was revoked. Grant it again before approving.');
  const currentHash = hashPayload(action.payload);
  if (payloadHash !== action.payload_hash || currentHash !== action.payload_hash) {
    throw new HttpError(409, 'The prepared action changed. Review it and approve again.');
  }

  action.status = 'approved';
  action.approved_at = nowIso();
  action.approved_by = principal.sub;
  recordAudit({
    case_id: record.case_id,
    actor: principal.sub,
    event: 'action_approved',
    decision: 'allow',
    detail: {
      action_id: action.action_id,
      payload_hash: action.payload_hash,
      steps: action.payload.steps.map((step) => ({ tool: step.tool, partner: step.partner, amount_inr: step.amount_inr })),
    },
  });
  addTimeline(record, {
    title: `You approved: ${action.title}`,
    detail: `Approval is bound to payload ${action.payload_hash.slice(0, 12)}.`,
    actor: 'customer',
  });

  const token = signApprovalToken({
    case_id: record.case_id,
    action_id: action.action_id,
    payload_hash: action.payload_hash,
    sub: principal.sub,
  });
  for (const step of action.payload.steps) {
    const result = await invokeTool<{ reference: string; partner: string }>(step.tool, step.input, {
      principal,
      caseRecord: record,
      approval: { token, action },
    });
    action.partner_requests.push({
      tool: step.tool,
      partner: result.partner,
      reference: result.reference,
      amount_inr: step.amount_inr,
      summary: step.summary,
      status: 'submitted',
      updates: [{ at: nowIso(), status: 'submitted', message: step.summary }],
    });
  }

  if (action.payload.handoff) {
    action.status = 'completed';
    const ticket = action.partner_requests.find((request) => request.tool === 'crm.handoff_to_agent');
    addTimeline(record, {
      status: 'human_review',
      title: 'Passport shared with a specialist',
      detail: `${ticket ? `Support handoff ${ticket.reference}. ` : ''}A specialist continues from the same facts; no partner action was taken.`,
      actor: 'saathi',
    });
    addMessage(record, 'assistant', 'I shared your Resolution Passport with a Saathi specialist. You will not need to repeat your story.');
    updateCase(record);
    return record;
  }

  action.status = 'in_progress';
  traceStandalone(
    record,
    'action_approved',
    'action_tracker',
    `Gateway verified approval token and payload hash; ${action.partner_requests.length} write(s) submitted.`,
    action.partner_requests.map((request) => request.tool),
  );
  const total = action.payload.steps.reduce((sum, step) => sum + step.amount_inr, 0);
  addTimeline(record, {
    status: 'in_progress',
    title: 'Submitted to partners (simulated)',
    detail: action.partner_requests.map((request) => `${request.tool} -> ${request.reference}`).join('; '),
    actor: 'saathi',
  });
  addMessage(
    record,
    'assistant',
    `Approved. I submitted ${action.partner_requests.length} step(s)${total ? ` covering ${formatInr(total)}` : ''} to the simulated partners. Track live status in the timeline.`,
  );
  updateCase(record);
  void dispatchApprovedAction(record.case_id, action.action_id);
  return record;
}
