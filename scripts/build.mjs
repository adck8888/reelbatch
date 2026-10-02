import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip');
const out = 'dist';

await rm(out, { recursive: true, force: true });
await mkdir(`${out}/config`, { recursive: true });
await cp('public', out, { recursive: true });
await cp('config/flow.json', `${out}/config/flow.json`);

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
manifest.version = pkg.version;
await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));

const common = {
  bundle: true,
  outdir: out,
  target: 'chrome120',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': watch ? '"development"' : '"production"',
    __VERSION__: JSON.stringify(pkg.version)
  },
  logLevel: 'info'
};

// The service worker and the panel are ES modules; content scripts must be classic scripts.
const builds = [
  {
    ...common,
    entryPoints: { background: 'src/background/index.ts', panel: 'src/panel/index.tsx', offscreen: 'src/offscreen/index.ts' },
    format: 'esm',
    // xlsx / mammoth / papaparse load on demand from the panel
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]'
  },
  {
    ...common,
    entryPoints: { 'flow-content': 'src/engines/flow/content.ts', 'flow-page': 'src/engines/flow/page-hook.ts' },
    format: 'iife'
  }
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  for (const options of builds) await esbuild.build(options);
  if (zip) {
    const files = {};
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files[relative(out, p).split(sep).join('/')] = readFileSync(p);
      }
    };
    walk(out);
    await writeFile(`reelbatch-${pkg.version}.zip`, zipSync(files, { level: 9 }));
    console.log(`reelbatch-${pkg.version}.zip`);
  }
}
