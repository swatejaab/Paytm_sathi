import { Router } from 'express';
import { z } from 'zod';
import { approveAction, cancelAction, prepareAction } from '../actions';
import { getPrincipal, requireAuth } from '../auth';
import { createConversation, handleTurn, NEW_CHAT_TITLE } from '../assistant/turn';
import { onCaseUpdate } from '../caseEvents';
import { loadCaseForOwner, loadCaseForRead } from '../caseStore';
import { deleteCase, listAudit, listCases, recordAudit, updateCase } from '../db';
import { HttpError, parseBody } from '../errors';
import { buildPassport } from '../passport';
import { suggestedProduct } from '../products';
import { addSpecialistNote, claimCase, resolveBySpecialist, reviewCase } from '../support';
import { LANGUAGE_CODES } from '../languages';
import type { CaseRecord } from '../types';
import { confirmBill, confirmTransaction, createCase, requestHandoff, setConsent } from '../workflow';

export const caseRouter = Router();

const intakeSchema = z
  .object({
    message: z.string().trim().min(8).max(2000),
    consent_to_read_case_data: z.boolean().default(false),
    language: z.enum(LANGUAGE_CODES).optional(),
  })
  .strict();
const consentSchema = z.object({ purpose: z.literal('prepare_resolution_options'), granted: z.boolean() }).strict();
const confirmationSchema = z.object({ transaction_id: z.string().min(3).max(40), recognized: z.boolean() }).strict();
const handoffSchema = z.object({ reason: z.string().max(300).optional() }).strict();
const prepareSchema = z.object({ option_id: z.string().min(2).max(60) }).strict();
const approveSchema = z.object({ payload_hash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict();

function summarize(record: CaseRecord) {
  const last = record.messages.at(-1);
  return {
    case_id: record.case_id,
    customer_id: record.customer_id,
    title: record.title ?? (record.customer_message.split('\n')[0]?.slice(0, 60) || NEW_CHAT_TITLE),
    journey: record.context?.journey ?? null,
    event_type: record.event_type,
    urgency: record.urgency,
    status: record.status,
    customer_message: record.customer_message.slice(0, 160),
    last_message: last ? last.content.slice(0, 120) : null,
    message_count: record.messages.length,
    has_plan: Boolean(record.decision),
    recommended_option: record.decision?.options.find((option) => option.recommended)?.title ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

const chatSchema = z
  .object({
    conversation_id: z.string().min(3).max(40).optional(),
    message: z.string().trim().min(1).max(2000),
    language: z.enum(LANGUAGE_CODES).optional(),
  })
  .strict();
const newConversationSchema = z.object({ language: z.enum(LANGUAGE_CODES).optional() }).strict();
const renameSchema = z.object({ title: z.string().trim().min(1).max(80) }).strict();

caseRouter.post('/chat', requireAuth('case:create'), async (req, res) => {
  const body = parseBody(chatSchema, req.body);
  const record = await handleTurn(getPrincipal(req), body);
  res.status(body.conversation_id ? 200 : 201).json(record);
});

caseRouter.post('/conversations', requireAuth('case:create'), (req, res) => {
  const body = parseBody(newConversationSchema, req.body ?? {});
  res.status(201).json(createConversation(getPrincipal(req), body.language));
});

caseRouter.patch('/cases/:caseId', requireAuth('case:create'), (req, res) => {
  const body = parseBody(renameSchema, req.body);
  const principal = getPrincipal(req);
  const record = loadCaseForOwner(principal, String(req.params.caseId), 'case:create');
  record.title = body.title;
  record.title_locked = true;
  recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'conversation_renamed' });
  updateCase(record);
  res.json(summarize(record));
});

function assertDeletable(record: CaseRecord): void {
  if (record.status === 'in_progress' || record.actions.some((action) => action.status === 'in_progress' || action.status === 'approved')) {
    throw new HttpError(409, 'This conversation has a request in progress with a partner, so it cannot be deleted yet.');
  }
}

caseRouter.delete('/cases/:caseId', requireAuth('case:create'), (req, res) => {
  const principal = getPrincipal(req);
  const record = loadCaseForOwner(principal, String(req.params.caseId), 'case:create');
  assertDeletable(record);
  deleteCase(record.case_id, principal.sub);
  recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'conversation_deleted' });
  res.status(204).end();
});

caseRouter.delete('/conversations', requireAuth('case:create'), (req, res) => {
  const principal = getPrincipal(req);
  let deleted = 0;
  let kept = 0;
  for (const record of listCases(principal.sub)) {
    try {
      assertDeletable(record);
      deleteCase(record.case_id, principal.sub);
      deleted += 1;
    } catch {
      kept += 1;
    }
  }
  recordAudit({ actor: principal.sub, event: 'conversations_deleted', detail: { deleted, kept } });
  res.json({ deleted, kept });
});

caseRouter.post('/cases/intake', requireAuth('case:create'), async (req, res) => {
  const body = parseBody(intakeSchema, req.body);
  res.status(201).json(await createCase(getPrincipal(req), body.message, body.consent_to_read_case_data, body.language));
});

caseRouter.get('/cases', requireAuth('case:read'), (req, res) => {
  const cases = listCases(getPrincipal(req).sub)
    .filter((record) => record.messages.length > 0)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map(summarize);
  res.json({ cases });
});

caseRouter.get('/support/cases', requireAuth('support:queue'), (_req, res) => {
  const cases = listCases().map(summarize);
  cases.sort((a, b) => Number(b.status === 'human_review') - Number(a.status === 'human_review'));
  res.json({ cases });
});

caseRouter.get('/cases/:caseId', requireAuth('case:read', 'case:read:any'), (req, res) => {
  res.json(loadCaseForRead(getPrincipal(req), String(req.params.caseId)));
});

caseRouter.get('/cases/:caseId/passport', requireAuth('case:read', 'case:read:any'), (req, res) => {
  res.json(buildPassport(loadCaseForRead(getPrincipal(req), String(req.params.caseId))));
});

// The loan or policy Saathi recommends for this case, so the customer can apply in-app. Nothing is offered otherwise.
caseRouter.get('/cases/:caseId/product', requireAuth('action:approve'), (req, res) => {
  const record = loadCaseForOwner(getPrincipal(req), String(req.params.caseId), 'action:approve');
  const product = suggestedProduct(record);
  if (!product) throw new HttpError(404, "Saathi isn't suggesting a loan or a policy for this case.");
  res.json(product);
});

caseRouter.get('/cases/:caseId/audit', requireAuth('case:read', 'case:read:any'), (req, res) => {
  const record = loadCaseForRead(getPrincipal(req), String(req.params.caseId));
  res.json({ case_id: record.case_id, events: listAudit(record.case_id) });
});

caseRouter.post('/cases/:caseId/consents', requireAuth('consent:manage'), async (req, res) => {
  const body = parseBody(consentSchema, req.body);
  res.json(await setConsent(getPrincipal(req), String(req.params.caseId), body.granted));
});

caseRouter.post('/cases/:caseId/transaction-confirmation', requireAuth('case:read'), async (req, res) => {
  const body = parseBody(confirmationSchema, req.body);
  res.json(await confirmTransaction(getPrincipal(req), String(req.params.caseId), body.transaction_id, body.recognized));
});

caseRouter.post('/cases/:caseId/handoff', requireAuth('case:read'), (req, res) => {
  const body = parseBody(handoffSchema, req.body);
  res.json(requestHandoff(getPrincipal(req), String(req.params.caseId), body.reason));
});

caseRouter.post('/cases/:caseId/actions', requireAuth('action:approve'), async (req, res) => {
  const body = parseBody(prepareSchema, req.body);
  res.status(201).json(await prepareAction(getPrincipal(req), String(req.params.caseId), body.option_id));
});

caseRouter.post('/cases/:caseId/actions/:actionId/approve', requireAuth('action:approve'), async (req, res) => {
  const body = parseBody(approveSchema, req.body);
  res.json(await approveAction(getPrincipal(req), String(req.params.caseId), String(req.params.actionId), body.payload_hash));
});

caseRouter.post('/cases/:caseId/actions/:actionId/cancel', requireAuth('action:approve'), (req, res) => {
  res.json(cancelAction(getPrincipal(req), String(req.params.caseId), String(req.params.actionId)));
});

// Live case feed (Server-Sent Events). Each push re-checks access, so a revoked or foreign case never streams.
caseRouter.get('/cases/:caseId/events', requireAuth('case:read', 'case:read:any'), (req, res) => {
  const principal = getPrincipal(req);
  const caseId = String(req.params.caseId);
  loadCaseForRead(principal, caseId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let lastSent = '';
  const push = () => {
    try {
      const record = loadCaseForRead(principal, caseId);
      if (record.updated_at === lastSent) return;
      lastSent = record.updated_at;
      res.write(`event: case\ndata: ${JSON.stringify(record)}\n\n`);
    } catch {
      res.end();
    }
  };
  push();
  const unsubscribe = onCaseUpdate(caseId, push);
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

const noteSchema = z.object({ text: z.string().trim().min(2).max(600), to_customer: z.boolean().default(false) }).strict();
const reviewSchema = z
  .object({
    verify_documents: z.boolean().default(false),
    option_id: z.string().min(2).max(60).optional(),
    message: z.string().max(400).optional(),
  })
  .strict();
const resolveSchema = z.object({ note: z.string().trim().min(3).max(400) }).strict();

caseRouter.post('/support/cases/:caseId/claim', requireAuth('support:act'), (req, res) => {
  res.json(claimCase(getPrincipal(req), String(req.params.caseId)));
});

caseRouter.post('/support/cases/:caseId/notes', requireAuth('support:act'), (req, res) => {
  const body = parseBody(noteSchema, req.body);
  res.json(addSpecialistNote(getPrincipal(req), String(req.params.caseId), body.text, body.to_customer));
});

caseRouter.post('/support/cases/:caseId/review', requireAuth('support:act'), async (req, res) => {
  const body = parseBody(reviewSchema, req.body);
  res.json(await reviewCase(getPrincipal(req), String(req.params.caseId), body));
});

caseRouter.post('/support/cases/:caseId/resolve', requireAuth('support:act'), (req, res) => {
  const body = parseBody(resolveSchema, req.body);
  res.json(resolveBySpecialist(getPrincipal(req), String(req.params.caseId), body.note));
});

const billConfirmationSchema = z
  .object({
    document_id: z.string().min(3).max(40),
    confirmed: z.boolean(),
    total_inr: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();

caseRouter.post('/cases/:caseId/bill-confirmation', requireAuth('document:upload'), async (req, res) => {
  const body = parseBody(billConfirmationSchema, req.body);
  res.json(await confirmBill(getPrincipal(req), String(req.params.caseId), body));
});
