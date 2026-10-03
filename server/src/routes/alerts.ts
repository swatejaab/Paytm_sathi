import { Router } from 'express';
import { z } from 'zod';
import { alertsFor, dismissAlert, setAlertsEnabled } from '../alerts';
import { getPrincipal, requireAuth } from '../auth';
import { HttpError, parseBody } from '../errors';
import { assessAffordability, parseIndianAmount, purchaseCategory } from '../afford';
import { getPreferences, recordAudit, savePreferences, standingConsents } from '../db';
import { buildForecast } from '../forecast';
import { SCORE_ACTIONS, type ScoreAction } from '../credit';
import { invokeAccountTool } from '../mcp/gateway';
import { buildTwin } from '../twin';

export const alertRouter = Router();

alertRouter.get('/alerts', requireAuth('case:create'), (req, res) => {
  res.json(alertsFor(getPrincipal(req).sub));
});

alertRouter.post('/alerts/settings', requireAuth('case:create'), (req, res) => {
  const body = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body);
  const principal = getPrincipal(req);
  setAlertsEnabled(principal.sub, body.enabled);
  res.json(alertsFor(principal.sub));
});

alertRouter.post('/alerts/:alertId/dismiss', requireAuth('case:create'), (req, res) => {
  const principal = getPrincipal(req);
  dismissAlert(principal.sub, String(req.params.alertId).slice(0, 120));
  res.json(alertsFor(principal.sub));
});

alertRouter.get('/twin', requireAuth('case:create'), (req, res) => {
  const twin = buildTwin(getPrincipal(req).sub);
  if (!twin) throw new HttpError(404, 'No synthetic financial profile exists for this customer.');
  res.json(twin);
});

const forecastQuery = z
  .object({
    salary_delay_days: z.coerce.number().int().min(0).max(20).optional(),
    horizon_days: z.coerce.number().int().refine((value) => [7, 14, 30].includes(value)).optional(),
    skip: z.string().max(600).optional(),
  })
  .strict();

alertRouter.get('/forecast', requireAuth('case:create'), (req, res) => {
  const query = parseBody(forecastQuery, req.query);
  const principal = getPrincipal(req);
  const forecast = buildForecast(principal.sub, {
    salary_delay_days: query.salary_delay_days,
    skip: query.skip ? query.skip.split(',').filter(Boolean) : [],
  }, query.horizon_days ?? 30);
  if (!forecast) throw new HttpError(404, 'No synthetic financial profile exists for this customer.');
  recordAudit({ actor: principal.sub, event: 'forecast_viewed', detail: { what_if: forecast.what_if } });
  res.json(forecast);
});

const affordSchema = z
  .object({
    question: z.string().trim().min(3).max(300).optional(),
    amount_inr: z.number().int().positive().max(100_000_000).optional(),
    item: z.string().trim().max(80).optional(),
  })
  .strict();

alertRouter.post('/afford', requireAuth('case:create'), (req, res) => {
  const body = parseBody(affordSchema, req.body);
  const principal = getPrincipal(req);
  const amount = body.amount_inr ?? (body.question ? parseIndianAmount(body.question) : null);
  if (!amount) throw new HttpError(422, 'Tell me the price, for example "Can I afford a 1.2 lakh phone?"');
  const text = `${body.item ?? ''} ${body.question ?? ''}`;
  const item = body.item ?? body.question?.replace(/^(can|could|should)\s+i\s+(afford|buy)\s+(an?\s+)?/i, '').replace(/\?+$/, '').slice(0, 80);
  const result = assessAffordability(principal.sub, { amount_inr: amount, item, category: purchaseCategory(text) });
  if (!result) throw new HttpError(404, 'No synthetic financial profile exists for this customer.');
  recordAudit({ actor: principal.sub, event: 'affordability_checked', detail: { amount_inr: amount, verdict: result.verdict } });
  res.json(result);
});

const creditSchema = z.object({ consent: z.literal(true) }).strict();
const simulateSchema = z
  .object({ consent: z.literal(true), action: z.enum(Object.keys(SCORE_ACTIONS) as [ScoreAction, ...ScoreAction[]]) })
  .strict();

alertRouter.post('/credit/score', requireAuth('case:create'), async (req, res) => {
  parseBody(creditSchema, req.body);
  res.json(await invokeAccountTool('bureau.get_credit_report', { purpose: 'self_check' }, { principal: getPrincipal(req), consent: true }));
});

alertRouter.post('/credit/simulate', requireAuth('case:create'), async (req, res) => {
  const body = parseBody(simulateSchema, req.body);
  res.json(await invokeAccountTool('bureau.simulate_score', { action: body.action }, { principal: getPrincipal(req), consent: true }));
});

alertRouter.get('/consents', requireAuth('case:create'), (req, res) => {
  res.json(standingConsents(getPrincipal(req).sub));
});

const consentPrefsSchema = z.object({ records: z.boolean().optional(), ai: z.boolean().optional(), voice: z.boolean().optional() }).strict();

alertRouter.post('/consents', requireAuth('case:create'), (req, res) => {
  const body = parseBody(consentPrefsSchema, req.body);
  const principal = getPrincipal(req);
  const preferences = getPreferences(principal.sub);
  savePreferences(principal.sub, { ...preferences, consents: { ...preferences.consents, ...body } });
  recordAudit({ actor: principal.sub, event: 'standing_consent_updated', detail: body });
  res.json(standingConsents(principal.sub));
});

const goalSchema = z
  .object({
    goal: z.string().trim().min(2).max(60),
    target_inr: z.number().int().positive().max(100_000_000),
    target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    saved_inr: z.number().int().min(0).max(100_000_000).default(0),
  })
  .strict();

alertRouter.post('/goals', requireAuth('case:create'), (req, res) => {
  const body = parseBody(goalSchema, req.body);
  const principal = getPrincipal(req);
  const preferences = getPreferences(principal.sub);
  const goals = [...(preferences.goals ?? []), { id: `GOAL-${Date.now().toString(36).toUpperCase()}`, ...body }].slice(-12);
  savePreferences(principal.sub, { ...preferences, goals });
  recordAudit({ actor: principal.sub, event: 'goal_added', detail: { goal: body.goal } });
  res.status(201).json(buildTwin(principal.sub, { audit: false })?.goals ?? []);
});

alertRouter.delete('/goals/:goalId', requireAuth('case:create'), (req, res) => {
  const principal = getPrincipal(req);
  const preferences = getPreferences(principal.sub);
  savePreferences(principal.sub, { ...preferences, goals: (preferences.goals ?? []).filter((goal) => goal.id !== String(req.params.goalId)) });
  res.json(buildTwin(principal.sub, { audit: false })?.goals ?? []);
});
