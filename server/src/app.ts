import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { FRONTEND_DIST_DIR, settings } from './config';
import { HttpError } from './errors';
import { GATEWAY_STATUS, GatewayError } from './mcp/errors';
import { authRouter } from './routes/auth';
import { caseRouter } from './routes/cases';
import { evidenceRouter } from './routes/evidence';
import { partnerRouter } from './routes/partners';
import { systemRouter } from './routes/system';

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ detail: error.detail });
    return;
  }
  if (error instanceof GatewayError) {
    res.status(GATEWAY_STATUS[error.code]).json({ detail: error.message, code: error.code });
    return;
  }
  if (error instanceof multer.MulterError) {
    res.status(422).json({ detail: error.code === 'LIMIT_FILE_SIZE' ? 'The uploaded file is too large.' : error.message });
    return;
  }
  const type = (error as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') {
    res.status(400).json({ detail: 'Malformed JSON body.' });
    return;
  }
  if (type === 'entity.too.large') {
    res.status(413).json({ detail: 'Request body is too large.' });
    return;
  }
  console.error('[api] unhandled error', error);
  res.status(500).json({ detail: 'Internal server error' });
};

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(
    cors({
      origin: settings.frontendOrigins,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
    }),
  );
  app.use(
    express.json({
      limit: '100kb',
      verify: (req, _res, buffer) => {
        (req as express.Request).rawBody = Buffer.from(buffer);
      },
    }),
  );

  app.use('/api', systemRouter);
  app.use('/api', authRouter);
  app.use('/api', partnerRouter);
  app.use('/api', caseRouter);
  app.use('/api', evidenceRouter);
  app.use('/api', (_req, res) => {
    res.status(404).json({ detail: 'Not found' });
  });

  const indexHtml = path.join(FRONTEND_DIST_DIR, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(FRONTEND_DIST_DIR, { index: false }));
    app.use((req, res, next) => {
      if (req.method === 'GET' || req.method === 'HEAD') res.sendFile(indexHtml);
      else next();
    });
  }

  app.use(errorHandler);
  return app;
}
