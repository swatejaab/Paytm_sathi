import crypto from 'node:crypto';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashPayload(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function hmacSha256Hex(secret: string, body: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
