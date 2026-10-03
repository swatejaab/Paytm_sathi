import { runAgent } from './agent/graph';
import { addMessage, addTimeline, loadCaseForRead } from './caseStore';
import { nowIso, recordAudit, updateCase } from './db';
import { HttpError } from './errors';
import type { CaseRecord, Principal, SpecialistDesk } from './types';

function desk(record: CaseRecord): SpecialistDesk {
  record.specialist ??= { assigned_to: null, assigned_name: null, assigned_at: null, verified_documents: false, notes: [] };
  return record.specialist;
}

function loadForSpecialist(principal: Principal, caseId: string, requireAssignment = true): CaseRecord {
  if (!principal.scopes.includes('support:act')) throw new HttpError(403, 'This action needs the support:act scope.');
  const record = loadCaseForRead(principal, caseId);
  if (requireAssignment && desk(record).assigned_to !== principal.sub) {
    throw new HttpError(409, 'Pick up the case before acting on it.');
  }
  return record;
}

export function claimCase(principal: Principal, caseId: string): CaseRecord {
  const record = loadForSpecialist(principal, caseId, false);
  const specialist = desk(record);
  if (specialist.assigned_to && specialist.assigned_to !== principal.sub) {
    throw new HttpError(409, `Already picked up by ${specialist.assigned_name ?? specialist.assigned_to}.`);
  }
  if (record.status === 'resolved') throw new HttpError(409, 'This case is already resolved.');
  Object.assign(specialist, { assigned_to: principal.sub, assigned_name: principal.display_name, assigned_at: nowIso() });
  addTimeline(record, {
    title: `${principal.display_name} picked up your case`,
    detail: 'The specialist works from your Resolution Passport, so you do not need to repeat your story.',
    actor: 'support',
  });
  recordAudit({ case_id: caseId, actor: principal.sub, event: 'specialist_claimed' });
  updateCase(record);
  return record;
}

export function addSpecialistNote(principal: Principal, caseId: string, text: string, toCustomer: boolean): CaseRecord {
  const record = loadForSpecialist(principal, caseId);
  desk(record).notes.push({ at: nowIso(), author: principal.display_name, text, to_customer: toCustomer });
  if (toCustomer) {
    addMessage(record, 'assistant', `${principal.display_name} (Saathi specialist): ${text}`, { source: 'saathi' });
    addTimeline(record, { title: 'Message from your specialist', detail: text.slice(0, 160), actor: 'support' });
  }
  recordAudit({ case_id: caseId, actor: principal.sub, event: 'specialist_note', detail: { to_customer: toCustomer } });
  updateCase(record);
  return record;
}

// Verifies uploaded documents and/or points the customer to an option. The customer still approves any action.
export async function reviewCase(
  principal: Principal,
  caseId: string,
  input: { verify_documents: boolean; option_id?: string; message?: string },
): Promise<CaseRecord> {
  const record = loadForSpecialist(principal, caseId);
  if (['in_progress', 'resolved'].includes(record.status)) throw new HttpError(409, `The case is ${record.status}; nothing to review.`);
  if (input.verify_documents) {
    if (!record.uploaded_documents.length) throw new HttpError(422, 'There are no customer documents to verify.');
    desk(record).verified_documents = true;
    addTimeline(record, {
      title: 'Specialist verified your documents',
      detail: `${record.uploaded_documents.length} upload${record.uploaded_documents.length === 1 ? '' : 's'} checked.`,
      actor: 'support',
    });
    recordAudit({ case_id: caseId, actor: principal.sub, event: 'documents_verified' });
    if (record.event_type === 'hospitalization') {
      const result = await runAgent(record, principal, 'documents_updated');
      if (result.error) throw new HttpError(502, `Recalculation failed: ${result.error}`);
    }
  }
  const message = input.message?.trim() ?? '';
  if (input.option_id) {
    const decision = record.decision;
    const chosen = decision?.options.find((option) => option.option_id === input.option_id);
    if (!decision || !chosen) throw new HttpError(404, 'Option not found.');
    if (!chosen.feasible) throw new HttpError(422, 'That option is blocked by a guardrail and cannot be recommended.');
    decision.options.forEach((option) => (option.recommended = option === chosen));
    decision.recommended_option_id = chosen.option_id;
    decision.warnings = [...decision.warnings, `Recommended by specialist ${principal.display_name}.`];
    addTimeline(record, {
      status: 'options_ready',
      title: `Specialist recommends: ${chosen.title}`,
      detail: 'Review it in your plan. Nothing happens until you approve.',
      actor: 'support',
    });
    addMessage(
      record,
      'assistant',
      `${principal.display_name} (Saathi specialist) recommends "${chosen.title}".${message ? ` ${message}` : ''} Nothing happens until you approve it in your plan.`,
    );
    recordAudit({ case_id: caseId, actor: principal.sub, event: 'specialist_recommended', detail: { option_id: chosen.option_id } });
  } else if (message) {
    addMessage(record, 'assistant', `${principal.display_name} (Saathi specialist): ${message}`);
  }
  updateCase(record);
  return record;
}

export function resolveBySpecialist(principal: Principal, caseId: string, note: string): CaseRecord {
  const record = loadForSpecialist(principal, caseId);
  if (record.status === 'in_progress') throw new HttpError(409, 'Partner steps are still running; let them finish first.');
  addTimeline(record, { status: 'resolved', title: 'Resolved by your specialist', detail: note, actor: 'support' });
  addMessage(record, 'assistant', `${principal.display_name} (Saathi specialist) closed this case: ${note}`);
  recordAudit({ case_id: caseId, actor: principal.sub, event: 'specialist_resolved' });
  updateCase(record);
  return record;
}
