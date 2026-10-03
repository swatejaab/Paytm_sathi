import { Router } from 'express';
import { z } from 'zod';
import { approveAction, cancelAction, prepareAction } from '../actions';
import { getPrincipal, requireAuth } from '../auth';
import { onCaseUpdate } from '../caseEvents';
import { loadCaseForRead } from '../caseStore';
import { listAudit, listCases } from '../db';
import { parseBody } from '../errors';
import { buildPassport } from '../passport';
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
  return {
    case_id: record.case_id,
    customer_id: record.customer_id,
    event_type: record.event_type,
    urgency: record.urgency,
    status: record.status,
    customer_message: record.customer_message.slice(0, 160),
    recommended_option: record.decision?.options.find((option) => option.recommended)?.title ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

caseRouter.post('/cases/intake', requireAuth('case:create'), async (req, res) => {
  const body = parseBody(intakeSchema, req.body);
  res.status(201).json(await createCase(getPrincipal(req), body.message, body.consent_to_read_case_data, body.language));
});

caseRouter.get('/cases', requireAuth('case:read'), (req, res) => {
  res.json({ cases: listCases(getPrincipal(req).sub).map(summarize) });
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
