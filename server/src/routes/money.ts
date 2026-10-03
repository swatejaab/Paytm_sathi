import { Router } from 'express';
import { z } from 'zod';
import { getPrincipal, requireAuth } from '../auth';
import { settings } from '../config';
import { listCases, recordAudit } from '../db';
import { HttpError, parseBody } from '../errors';
import { financialContext } from '../financialContext';
import { GOAL_TYPES, createGoal, listGoals, removeGoal, updateGoal } from '../goals';
import { buildInsights } from '../insights';

export const moneyRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2028-12-31.');
const goalFields = {
  name: z.string().trim().min(2).max(80),
  type: z.enum(GOAL_TYPES),
  target_inr: z.number().int().positive().max(1_000_000_000),
  target_date: isoDate.nullable(),
  current_savings_inr: z.number().int().min(0).max(1_000_000_000),
  monthly_contribution_inr: z.number().int().min(0).max(100_000_000).nullable(),
  priority: z.enum(['high', 'medium', 'low']),
};
const goalCreateSchema = z.object(goalFields).strict();
const goalPatchSchema = z
  .object({ ...goalFields, status: z.enum(['active', 'paused', 'completed']) })
  .partial()
  .strict();

moneyRouter.get('/goals', requireAuth('case:create'), (req, res) => {
  res.json({ goals: listGoals(getPrincipal(req).sub) });
});

moneyRouter.post('/goals', requireAuth('case:create'), (req, res) => {
  const body = parseBody(goalCreateSchema, req.body);
  const principal = getPrincipal(req);
  if (body.target_date && body.target_date <= settings.demoDate) throw new HttpError(422, 'Choose a target date in the future.');
  const goal = createGoal(principal.sub, body);
  recordAudit({ actor: principal.sub, event: 'goal_created', detail: { goal_id: goal.goal_id, type: goal.type } });
  res.status(201).json(goal);
});

moneyRouter.patch('/goals/:goalId', requireAuth('case:create'), (req, res) => {
  const body = parseBody(goalPatchSchema, req.body);
  const principal = getPrincipal(req);
  const goal = updateGoal(principal.sub, String(req.params.goalId), body);
  if (!goal) throw new HttpError(404, 'Goal not found.');
  recordAudit({ actor: principal.sub, event: 'goal_updated', detail: { goal_id: goal.goal_id, fields: Object.keys(body) } });
  res.json(goal);
});

moneyRouter.delete('/goals/:goalId', requireAuth('case:create'), (req, res) => {
  const principal = getPrincipal(req);
  if (!removeGoal(principal.sub, String(req.params.goalId))) throw new HttpError(404, 'Goal not found.');
  recordAudit({ actor: principal.sub, event: 'goal_deleted', detail: { goal_id: String(req.params.goalId) } });
  res.status(204).end();
});

moneyRouter.get('/insights', requireAuth('case:create'), (req, res) => {
  const insights = buildInsights(getPrincipal(req).sub);
  if (!insights) throw new HttpError(404, 'We could not find financial records for your account yet.');
  res.json(insights);
});

moneyRouter.get('/financial-context', requireAuth('case:create'), (req, res) => {
  res.json(financialContext(getPrincipal(req).sub));
});

moneyRouter.get('/documents', requireAuth('case:create'), (req, res) => {
  const documents = listCases(getPrincipal(req).sub).flatMap((record) =>
    record.uploaded_documents.map((document) => ({
      document_id: document.document_id,
      document_name: document.document_name,
      document_type: document.document_type,
      page_count: document.page_count,
      uploaded_at: document.uploaded_at,
      case_id: record.case_id,
      conversation_title: record.title ?? null,
      confirmed: record.confirmed_bill?.document_id === document.document_id,
    })),
  );
  documents.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  res.json({ documents });
});
