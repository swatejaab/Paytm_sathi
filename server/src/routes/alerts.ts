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
import { maskPan, PAN_PATTERN, panOnFile, type Portfolio } from '../holdings';
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
  if (!twin) throw new HttpError(404, 'We could not find financial records for your account yet.');
  res.json(twin);
});

const forecastQuery = z
  .object({ salary_delay_days: z.coerce.number().int().min(0).max(20).optional(), skip: z.string().max(600).optional() })
  .strict();

alertRouter.get('/forecast', requireAuth('case:create'), (req, res) => {
  const query = parseBody(forecastQuery, req.query);
  const principal = getPrincipal(req);
  const forecast = buildForecast(principal.sub, {
    salary_delay_days: query.salary_delay_days,
    skip: query.skip ? query.skip.split(',').filter(Boolean) : [],
  });
  if (!forecast) throw new HttpError(404, 'We could not find financial records for your account yet.');
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
  if (!result) throw new HttpError(404, 'We could not find financial records for your account yet.');
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

alertRouter.get('/assets', requireAuth('case:create'), async (req, res) => {
  const principal = getPrincipal(req);
  const pan = panOnFile(principal.sub);
  const link = getPreferences(principal.sub).holdings_link;
  if (!pan || !link) {
    res.json({ linked: false, pan_on_file: pan ? maskPan(pan) : null });
    return;
  }
  const portfolio = await invokeAccountTool<Portfolio>('aa.fetch_holdings', { pan }, { principal, consent: true });
  res.json({ linked: true, linked_at: link.linked_at, pan_on_file: maskPan(pan), portfolio });
});

const linkSchema = z.object({ pan: z.string().trim().max(20).optional(), use_kyc_pan: z.boolean().optional(), consent: z.literal(true) }).strict();

alertRouter.post('/assets/link', requireAuth('case:create'), async (req, res) => {
  const body = parseBody(linkSchema, req.body);
  const principal = getPrincipal(req);
  const onFile = panOnFile(principal.sub);
  if (!onFile) throw new HttpError(404, 'We could not find a verified PAN on your account yet.');
  const pan = body.use_kyc_pan ? onFile : (body.pan ?? '').replace(/\s+/g, '').toUpperCase();
  if (!PAN_PATTERN.test(pan)) throw new HttpError(422, 'Enter a valid 10-character PAN, for example ABCDE1234F.');
  const portfolio = await invokeAccountTool<Portfolio>('aa.fetch_holdings', { pan }, { principal, consent: body.consent });
  const preferences = getPreferences(principal.sub);
  const linkedAt = new Date().toISOString();
  savePreferences(principal.sub, { ...preferences, holdings_link: { pan_masked: maskPan(pan), linked_at: linkedAt } });
  recordAudit({ actor: principal.sub, event: 'holdings_linked', detail: { pan_masked: maskPan(pan) } });
  res.json({ linked: true, linked_at: linkedAt, pan_on_file: maskPan(onFile), portfolio });
});

alertRouter.delete('/assets/link', requireAuth('case:create'), (req, res) => {
  const principal = getPrincipal(req);
  const { holdings_link: _removed, ...rest } = getPreferences(principal.sub);
  savePreferences(principal.sub, rest);
  recordAudit({ actor: principal.sub, event: 'holdings_unlinked' });
  const pan = panOnFile(principal.sub);
  res.json({ linked: false, pan_on_file: pan ? maskPan(pan) : null });
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
