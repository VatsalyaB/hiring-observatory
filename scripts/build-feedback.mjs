import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

const evidenceRoot = existsSync('public/docs/evidence') ? 'public/docs/evidence' : 'docs/evidence';

await build({
  entryPoints: [`${evidenceRoot}/feedback.mjs`],
  outfile: `${evidenceRoot}/feedback.bundle.js`,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  banner: { js: '/*! Includes @supabase/supabase-js (MIT License). */' },
});

const output = `${evidenceRoot}/feedback.bundle.js`;
const bundle = await readFile(output, 'utf8');
await writeFile(output, bundle.replace(/`([ \t]+)\n/g, (_match, whitespace) => `\`${whitespace.replaceAll(' ', '\\x20').replaceAll('\t', '\\t')}\n`));
