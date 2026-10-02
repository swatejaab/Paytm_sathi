import type { RequestHandler } from 'express';
import { HttpError } from './errors';

interface Bucket {
  count: number;
  resetAt: number;
}

// Fixed-window, in-memory limiter. Enough for a single-instance demo; use a shared store behind a load balancer.
export function rateLimit(options: { windowMs: number; max: () => number; key: (req: Parameters<RequestHandler>[0]) => string }): RequestHandler {
  const buckets = new Map<string, Bucket>();
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
    }
    const key = options.key(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const max = options.max();
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(max - bucket.count, 0)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
    }
    next();
  };
}
