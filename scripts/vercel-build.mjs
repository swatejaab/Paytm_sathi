// Builds the Vercel deployment with the Build Output API (https://vercel.com/docs/build-output-api/v3):
//   .vercel/output/static            the React app (Vite build), served from Vercel's CDN
//   .vercel/output/functions/api.func  the Express API bundled into one Node.js function, with data/ beside it
//   .vercel/output/config.json       routes: /api/* and /mcp/* go to the function, everything else is static
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.vercel', 'output');
const fn = path.join(output, 'functions', 'api.func');

fs.rmSync(output, { recursive: true, force: true });

console.log('[vercel-build] Building the frontend');
execSync('npm run build -w frontend', { cwd: root, stdio: 'inherit' });
fs.cpSync(path.join(root, 'frontend', 'dist'), path.join(output, 'static'), { recursive: true });

console.log('[vercel-build] Bundling the API function');
await build({
  entryPoints: [path.join(root, 'server', 'src', 'vercel.ts')],
  outfile: path.join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
  // CommonJS dependencies (Express, multer, jsonwebtoken) call require() inside the ES module bundle.
  banner: { js: "import { createRequire as __saathiRequire } from 'node:module'; const require = __saathiRequire(import.meta.url);" },
});

// Sample data the API reads at runtime. Saved state lives in /tmp on Vercel, never in the bundle.
fs.cpSync(path.join(root, 'data'), path.join(fn, 'data'), {
  recursive: true,
  filter: (source) => !/\.sqlite3(-shm|-wal)?$/.test(source),
});

fs.writeFileSync(
  path.join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 60,
    },
    null,
    2,
  ),
);

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

fs.writeFileSync(
  path.join(output, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/(.*)$', headers: securityHeaders, continue: true },
        { src: '^/assets/(.*)$', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, continue: true },
        { src: '^/(api|mcp)(/.*)?$', dest: '/api' },
        { handle: 'filesystem' },
        { src: '^/(.*)$', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);

const size = (fs.statSync(path.join(fn, 'index.mjs')).size / 1024 / 1024).toFixed(1);
console.log(`[vercel-build] Done: .vercel/output (API bundle ${size} MB)`);
