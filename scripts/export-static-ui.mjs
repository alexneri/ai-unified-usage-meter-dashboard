#!/usr/bin/env node
// Build a static Topology-B UI bundle under dist/web for Vercel/CF.
// Injects window.__AUD_CONFIG__.snapshotBase from SNAPSHOT_BASE (or argv).
// Never embeds provider secrets — only the collector origin URL.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist/web');
const uiDir = resolve(root, 'src/ui');
const distUi = resolve(root, 'dist/ui');

const snapshotBase = (process.env.SNAPSHOT_BASE ?? process.argv[2] ?? '').trim().replace(/\/+$/, '');

// 1) Bundle app.ts → dist/ui/app.js with the stamped build version (build-ui.mjs).
const build = spawnSync(process.execPath, [resolve(root, 'scripts/build-ui.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(outDir, { recursive: true });
copyFileSync(resolve(uiDir, 'styles.css'), resolve(outDir, 'styles.css'));
copyFileSync(resolve(distUi, 'app.js'), resolve(outDir, 'app.js'));

// iOS bookmark / PWA icons (generated instrument-gauge mark)
for (const name of ['apple-touch-icon.png', 'favicon.png', 'icon-192.png', 'icon-512.png']) {
  copyFileSync(resolve(uiDir, name), resolve(outDir, name));
}

const htmlIn = readFileSync(resolve(uiDir, 'index.html'), 'utf8');
const cfgJson = JSON.stringify({ snapshotBase });
// Escape </script> in case a pathological URL ever contains it.
const safeCfg = cfgJson.replace(/</g, '\\u003c');
const inject = `    <script>window.__AUD_CONFIG__=${safeCfg};</script>\n`;
const htmlOut = htmlIn.includes('</head>')
  ? htmlIn.replace('</head>', `${inject}  </head>`)
  : `${inject}${htmlIn}`;

writeFileSync(resolve(outDir, 'index.html'), htmlOut, 'utf8');

console.log(
  snapshotBase
    ? `static UI → ${outDir}  (snapshotBase=${snapshotBase})`
    : `static UI → ${outDir}  (snapshotBase empty — relative /api/snapshot; set SNAPSHOT_BASE for hybrid)`,
);
