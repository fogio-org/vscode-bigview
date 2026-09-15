/**
 * Launches VS Code (downloaded by @vscode/test-electron) with the extension under development
 * and runs test/integration/suite.ts inside the extension host.
 *
 *   npm run test:integration                 # 1 MB / 10 MB files
 *   BIGVIEW_LARGE=1 npm run test:integration # + 200 MB and 1 GB
 *   BIGVIEW_HUGE=1 npm run test:integration  # + 5 GB (M2 memory acceptance)
 *   BIGVIEW_GREP=tail npm run test:integration # only tests whose name matches
 */
import { runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { enabledTiers, ensureFixture, FIXTURES } from './fixtures';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  const outDir = path.join(root, '.vscode-test', 'out');
  await esbuild.build({
    entryPoints: [path.join(root, 'test/integration/suite.ts')],
    outfile: path.join(outDir, 'suite.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: 'inline',
    logLevel: 'warning',
  });

  const tiers = enabledTiers(process.env);
  for (const spec of Object.values(FIXTURES)) {
    if (tiers.has(spec.tier)) ensureFixture(root, spec);
  }

  const userDataDir = path.join(root, '.vscode-test', 'user-data');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(outDir, 'suite.js'),
    launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userDataDir}`],
    extensionTestsEnv: {
      BIGVIEW_ROOT: root,
      BIGVIEW_LARGE: process.env.BIGVIEW_LARGE ?? '',
      BIGVIEW_HUGE: process.env.BIGVIEW_HUGE ?? '',
      BIGVIEW_GREP: process.env.BIGVIEW_GREP ?? '',
    },
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
