import { z } from 'zod';
import { addMessage, addTimeline, mutateCase } from './caseStore';
import { n8nConfigured, settings } from './config';
import { claimPartnerEvent, findCase, nowIso, recordAudit, updateCase } from './db';
import { formatInr } from './decision';
import { HttpError } from './errors';
import { hmacSha256Hex } from './hashing';
import type { CaseAction, PartnerRequest, PartnerRequestStatus } from './types';

export const partnerEventSchema = z
  .object({
    event_id: z.string().min(6).max(120),
    case_id: z.string().regex(/^SA-[A-Z0-9]{8}$/),
    action_id: z.string().regex(/^ACT-[A-Z0-9]{8}$/),
    tool: z.string().min(3).max(60),
    status: z.enum(['acknowledged', 'completed', 'failed']),
    reference: z.string().max(40).optional(),
    message: z.string().min(3).max(300),
  })
  .strict();

export type PartnerEvent = z.infer<typeof partnerEventSchema>;

const STATUS_RANK: Record<PartnerRequestStatus, number> = { submitted: 0, acknowledged: 1, completed: 2, failed: 2 };

export function signPartnerBody(body: string): string {
  return `sha256=${hmacSha256Hex(settings.n8nWebhookSecret, body)}`;
}

export function applyPartnerEvent(event: PartnerEvent, channel: 'n8n' | 'local_mock'): { applied: boolean; duplicate: boolean } {
  const record = findCase(event.case_id);
  const action = record?.actions.find((candidate) => candidate.action_id === event.action_id);
  const request = action?.partner_requests.find((candidate) => candidate.tool === event.tool);
  if (!record || !action || !request) throw new HttpError(404, 'Unknown case, action, or partner request.');
  if (event.reference && event.reference !== request.reference) throw new HttpError(409, 'Partner reference does not match.');
  if (!claimPartnerEvent(event.event_id)) return { applied: false, duplicate: true };

  request.updates.push({ at: nowIso(), status: event.status, message: event.message });
  if (STATUS_RANK[event.status] > STATUS_RANK[request.status]) request.status = event.status;
  addTimeline(record, {
    title: event.message,
    detail: `${request.partner} / ${request.reference}${channel === 'local_mock' ? ' / simulated' : ' / via n8n'}`,
    actor: 'partner',
  });
  recordAudit({
    case_id: record.case_id,
    actor: `partner:${channel}`,
    event: 'partner_event',
    tool: event.tool,
    detail: { event_id: event.event_id, status: event.status, reference: request.reference },
  });

  if (event.status === 'failed' && action.status === 'in_progress') {
    action.status = 'failed';
    addTimeline(record, {
      status: 'human_review',
      title: 'Partner step failed; routed to a specialist',
      detail: 'The specialist receives your Resolution Passport and the partner trail.',
      actor: 'saathi',
    });
    addMessage(record, 'assistant', 'A partner step failed. I routed the case to a specialist with the full trail.');
  } else if (action.status === 'in_progress' && action.partner_requests.every((candidate) => candidate.status === 'completed')) {
    action.status = 'completed';
    addTimeline(record, {
      status: 'resolved',
      title: 'Case resolved',
      detail: 'All approved partner steps completed (simulated outcomes).',
      actor: 'saathi',
    });
    addMessage(record, 'assistant', `All approved steps for "${action.title}" are complete (simulated). Your Resolution Passport and timeline stay available.`);
  }
  updateCase(record);
  return { applied: true, duplicate: false };
}

function mockMessages(action: CaseAction, request: PartnerRequest): { acknowledged: string; completed: string } {
  const step = action.payload.steps.find((candidate) => candidate.tool === request.tool);
  const input = step?.input ?? {};
  switch (request.tool) {
    case 'hospital.request_document':
      return {
        acknowledged: `Hospital acknowledged the request for the ${String(input.document ?? 'document').toLowerCase()}`,
        completed: `${String(input.document ?? 'Document')} added to the claim packet`,
      };
    case 'claim.submit':
      return {
        acknowledged: `Insurer registered claim ${request.reference}`,
        completed: `Insurer approved ${formatInr(Number(input.estimated_coverage_inr ?? 0))} on claim ${request.reference} (simulated decision)`,
      };
    case 'lending.submit_application':
      return {
        acknowledged: `Lender received the ${formatInr(request.amount_inr)} application`,
        completed: `Lender approved and paid ${formatInr(request.amount_inr)} to the ${String(input.disburse_to ?? 'hospital')} (simulated)`,
      };
    case 'lending.request_due_date_change':
      return {
        acknowledged: `Lender received the request to move the EMI to ${String(input.requested_due_date ?? 'the new date')}`,
        completed: `Lender moved the EMI on ${String(input.loan_id ?? 'the loan')} to ${String(input.requested_due_date ?? 'the new date')} (simulated)`,
      };
    case 'payments.raise_refund_trace':
      return {
        acknowledged: `Refund trace ${request.reference} opened with the remitter bank`,
        completed: `${formatInr(request.amount_inr)} reversed plus ${formatInr(Number(input.compensation_inr ?? 0))} compensation credited (simulated)`,
      };
    case 'payments.open_dispute':
      return {
        acknowledged: `Dispute ${request.reference} registered with the payment network`,
        completed: `Provisional credit of ${formatInr(request.amount_inr)} issued while the dispute is investigated (simulated)`,
      };
    default:
      return { acknowledged: `${request.partner} acknowledged ${request.tool}`, completed: `${request.partner} completed ${request.tool}` };
  }
}

function scheduleLocalPartner(caseId: string, action: CaseAction): void {
  const events: PartnerEvent[] = [];
  for (const status of ['acknowledged', 'completed'] as const) {
    for (const request of action.partner_requests) {
      events.push({
        event_id: `${action.action_id}:${request.tool}:${status}`,
        case_id: caseId,
        action_id: action.action_id,
        tool: request.tool,
        status,
        reference: request.reference,
        message: mockMessages(action, request)[status],
      });
    }
  }
  events.forEach((event, index) => {
    const timer = setTimeout(() => {
      try {
        applyPartnerEvent(event, 'local_mock');
      } catch (error) {
        console.error('[partners] mock event failed', error);
      }
    }, settings.mockPartnerDelayMs * (index + 1));
    timer.unref();
  });
}

export async function dispatchApprovedAction(caseId: string, actionId: string): Promise<void> {
  const record = findCase(caseId);
  const action = record?.actions.find((candidate) => candidate.action_id === actionId);
  if (!record || !action) return;

  if (n8nConfigured()) {
    const body = JSON.stringify({
      event: 'saathi.action.approved',
      idempotency_key: action.idempotency_key,
      case_id: caseId,
      action_id: actionId,
      steps: action.partner_requests.map(({ tool, partner, reference, amount_inr, summary }) => ({ tool, partner, reference, amount_inr, summary })),
      callback_url: `${settings.publicApiBaseUrl}/api/partners/callback`,
      simulated: true,
    });
    try {
      const response = await fetch(settings.n8nWebhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': action.idempotency_key,
          'x-saathi-signature': signPartnerBody(body),
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`n8n responded with ${response.status}`);
      mutateCase(caseId, (current) => {
        const target = current.actions.find((candidate) => candidate.action_id === actionId);
        if (target) target.channel = 'n8n';
        addTimeline(current, { title: 'n8n workflow triggered', detail: 'Waiting for signed partner callbacks.', actor: 'system' });
      });
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      mutateCase(caseId, (current) =>
        addTimeline(current, {
          title: 'n8n unavailable; using the local simulated partner',
          detail: `Fallback reason: ${reason}.`,
          actor: 'system',
        }),
      );
    }
  }

  mutateCase(caseId, (current) => {
    const target = current.actions.find((candidate) => candidate.action_id === actionId);
    if (target) target.channel = 'local_mock';
  });
  scheduleLocalPartner(caseId, action);
}
