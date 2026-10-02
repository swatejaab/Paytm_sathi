import type { Principal } from './types';

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
      rawBody?: Buffer;
    }
  }
}

export {};
