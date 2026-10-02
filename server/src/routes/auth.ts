import { Router } from 'express';
import { z } from 'zod';
import { authenticateDemoUser, getPrincipal, issueAccessToken, publicUser, requireAuth } from '../auth';
import { recordAudit } from '../db';
import { HttpError, parseBody } from '../errors';
import { fixtures } from '../fixtures';

export const authRouter = Router();

const loginSchema = z.object({ user_id: z.string().min(3).max(80), passcode: z.string().min(1).max(64) }).strict();

authRouter.get('/auth/demo-users', (_req, res) => {
  res.json({ users: fixtures.users.map(publicUser) });
});

authRouter.post('/auth/login', (req, res) => {
  const body = parseBody(loginSchema, req.body);
  const user = authenticateDemoUser(body.user_id, body.passcode);
  recordAudit({ actor: body.user_id, event: 'login', decision: user ? 'allow' : 'deny' });
  if (!user) throw new HttpError(401, 'The demo ID or passcode is incorrect.');
  res.json(issueAccessToken(user));
});

authRouter.get('/auth/me', requireAuth(), (req, res) => {
  const principal = getPrincipal(req);
  res.json({ user_id: principal.sub, display_name: principal.display_name, role: principal.role, scopes: principal.scopes });
});
