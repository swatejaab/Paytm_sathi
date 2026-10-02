import { Router } from 'express';
import { settings } from '../config';
import { HttpError, parseBody } from '../errors';
import { safeEqual } from '../hashing';
import { applyPartnerEvent, partnerEventSchema, signPartnerBody } from '../partners';

export const partnerRouter = Router();

partnerRouter.post('/partners/callback', (req, res) => {
  if (!settings.n8nWebhookSecret) throw new HttpError(503, 'Partner callbacks are disabled until N8N_WEBHOOK_SECRET is set.');
  const signature = String(req.headers['x-saathi-signature'] ?? '');
  const rawBody = req.rawBody ?? Buffer.from('');
  if (!signature || !safeEqual(signature, signPartnerBody(rawBody.toString('utf8')))) {
    throw new HttpError(401, 'Invalid partner signature.');
  }
  const event = parseBody(partnerEventSchema, req.body);
  res.json(applyPartnerEvent(event, 'n8n'));
});
