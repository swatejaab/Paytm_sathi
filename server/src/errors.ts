import type { z, ZodTypeAny } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: unknown,
  ) {
    super(typeof detail === 'string' ? detail : 'Request failed');
  }
}

export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new HttpError(
      422,
      result.error.issues.map((issue) => ({ loc: issue.path, msg: issue.message })),
    );
  }
  return result.data;
}
