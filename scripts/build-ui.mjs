#!/usr/bin/env node
// Bundle the dumb-display UI (src/ui/app.ts → dist/ui/app.js) and stamp the build
// version. __APP_VERSION__ is injected via esbuild `define` so the footer can show
// "vX.Y.Z · <shortsha> · <date>". Shared by `npm run build:ui` and
// scripts/export-static-ui.mjs, so both topologies carry the same version string.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

function shortSha() {
  // Vercel/CI expose the SHA via env (no .git in the build image); locally use git.
  const env = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || '';
  if (env) return env.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

const date = process.env.BUILD_DATE || new Date().toISOString().slice(0, 10);
const version = `v${pkg.version} · ${shortSha()} · ${date}`;

await build({
  entryPoints: [resolve(root, 'src/ui/app.ts'), resolve(root, 'src/ui/history.ts')],
  bundle: true,
  format: 'esm',
  outdir: resolve(root, 'dist/ui'),
  logLevel: 'warning',
  define: { __APP_VERSION__: JSON.stringify(version) },
});

console.log(`built UI  (${version})`);
