import { Router } from 'express';
import { z } from 'zod';
import { alertsFor, dismissAlert, setAlertsEnabled } from '../alerts';
import { getPrincipal, requireAuth } from '../auth';
import { parseBody } from '../errors';

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
