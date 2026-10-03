import { Router } from 'express';
import { z } from 'zod';
import { authenticateDemoUser, getPrincipal, issueAccessToken, publicUser, requireAuth } from '../auth';
import { recordAudit } from '../db';
import { HttpError, parseBody } from '../errors';
import { settings } from '../config';
import { fixtures } from '../fixtures';
import { rateLimit } from '../rateLimit';

export const authRouter = Router();

const loginSchema = z.object({ user_id: z.string().min(3).max(80), passcode: z.string().min(1).max(64) }).strict();

authRouter.get('/auth/demo-users', (_req, res) => {
  res.json({ users: fixtures.users.map(publicUser) });
});

const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: () => settings.loginAttemptsPerMinute,
  key: (req) => `${req.ip}:${String((req.body as { user_id?: unknown } | undefined)?.user_id ?? '')}`,
});

authRouter.post('/auth/login', loginLimiter, (req, res) => {
  const body = parseBody(loginSchema, req.body);
  const user = authenticateDemoUser(body.user_id, body.passcode);
  recordAudit({ actor: body.user_id, event: 'login', decision: user ? 'allow' : 'deny' });
  if (!user) throw new HttpError(401, 'That user ID or PIN is incorrect.');
  res.json(issueAccessToken(user));
});

authRouter.get('/auth/me', requireAuth(), (req, res) => {
  const principal = getPrincipal(req);
  res.json({ user_id: principal.sub, display_name: principal.display_name, role: principal.role, scopes: principal.scopes });
});
