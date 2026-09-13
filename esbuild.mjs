// Builds three independent bundles: extension host, workers, webview.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const configs = [
  {
    ...common,
    entryPoints: { extension: 'src/extension.ts' },
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    loader: { '.html': 'text' },
  },
  {
    ...common,
    entryPoints: { 'indexer.worker': 'src/workers/indexer.worker.ts' },
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
  },
  {
    ...common,
    entryPoints: { webview: 'webview/main.ts' },
    outdir: 'dist',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
