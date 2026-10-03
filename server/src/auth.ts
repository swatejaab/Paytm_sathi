import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { settings } from './config';
import { HttpError } from './errors';
import { fixtures, type DemoUser } from './fixtures';
import { safeEqual } from './hashing';
import type { Principal, Role } from './types';

export const ROLE_SCOPES: Record<Role, string[]> = {
  customer: [
    'case:create',
    'case:read',
    'document:upload',
    'consent:manage',
    'action:approve',
    'voice:transcribe',
    'ai:analyze',
    'tools:list',
  ],
  support: ['case:read:any', 'support:queue', 'support:act', 'tools:list'],
};

export function publicUser(user: DemoUser) {
  return { user_id: user.user_id, display_name: user.display_name, role: user.role };
}

export function authenticateDemoUser(userId: string, passcode: string): DemoUser | null {
  const user = fixtures.users.find((candidate) => candidate.user_id === userId);
  const matches = safeEqual(user?.passcode ?? '\u0000no-user', passcode);
  return user && matches ? user : null;
}

export function issueAccessToken(user: DemoUser) {
  const token = jwt.sign({ role: user.role, scope: ROLE_SCOPES[user.role].join(' ') }, settings.jwtSecret, {
    algorithm: 'HS256',
    subject: user.user_id,
    issuer: settings.jwtIssuer,
    audience: settings.jwtAudience,
    expiresIn: settings.accessTokenTtlSeconds,
  });
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: settings.accessTokenTtlSeconds,
    user: publicUser(user),
  };
}

export function principalFromToken(token: string): Principal {
  let claims: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, settings.jwtSecret, {
      algorithms: ['HS256'],
      issuer: settings.jwtIssuer,
      audience: settings.jwtAudience,
    });
    if (typeof decoded === 'string') throw new Error('Unexpected token payload');
    claims = decoded;
  } catch {
    throw new HttpError(401, 'Your session is invalid or has expired. Sign in again.');
  }
  const user = fixtures.users.find((candidate) => candidate.user_id === claims.sub);
  if (!user || claims.role !== user.role) throw new HttpError(401, 'Unknown principal.');
  return { sub: user.user_id, role: user.role, display_name: user.display_name, scopes: [...ROLE_SCOPES[user.role]] };
}

export function requireAuth(...anyOfScopes: string[]): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new HttpError(401, 'Sign in to continue.');
    }
    const principal = principalFromToken(token);
    if (anyOfScopes.length && !anyOfScopes.some((scope) => principal.scopes.includes(scope))) {
      throw new HttpError(403, `This action needs one of these scopes: ${anyOfScopes.join(', ')}.`);
    }
    req.principal = principal;
    next();
  };
}

export function getPrincipal(req: Request): Principal {
  if (!req.principal) throw new HttpError(401, 'Sign in to continue.');
  return req.principal;
}

export function assertScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) throw new HttpError(403, `This action needs the ${scope} scope.`);
}

export interface ApprovalClaims {
  case_id: string;
  action_id: string;
  payload_hash: string;
  sub: string;
}

export function signApprovalToken(claims: ApprovalClaims): string {
  return jwt.sign(
    { typ: 'approval', case_id: claims.case_id, action_id: claims.action_id, payload_hash: claims.payload_hash },
    settings.jwtSecret,
    {
      algorithm: 'HS256',
      subject: claims.sub,
      issuer: settings.jwtIssuer,
      audience: settings.approvalAudience,
      expiresIn: settings.approvalTokenTtlSeconds,
    },
  );
}

export function verifyApprovalToken(token: string): ApprovalClaims {
  const decoded = jwt.verify(token, settings.jwtSecret, {
    algorithms: ['HS256'],
    issuer: settings.jwtIssuer,
    audience: settings.approvalAudience,
  });
  if (typeof decoded === 'string' || decoded.typ !== 'approval') throw new Error('Not an approval token');
  return {
    case_id: String(decoded.case_id),
    action_id: String(decoded.action_id),
    payload_hash: String(decoded.payload_hash),
    sub: String(decoded.sub),
  };
}
