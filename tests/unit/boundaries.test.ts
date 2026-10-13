import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? files(path) : [path];
  });
}

it('keeps shared contracts and browser code free of server SDK and configuration imports', () => {
  for (const directory of ['packages/shared/src', 'apps/web/src']) {
    for (const file of files(join(root, directory)).filter((path) => /\.(ts|tsx)$/.test(path) && !path.endsWith('.test.ts'))) {
      const source = readFileSync(file, 'utf8');

      expect(source, file).not.toMatch(/(?:from\s*|import\s*\()\s*['"](?:node:|openai|@aws-sdk|@bid\/api|[^'"]*apps\/api)/);
      expect(source, file).not.toMatch(/process\.env|LLM_API_KEY|AWS_SECRET_ACCESS_KEY/);
    }
  }

  for (const packageName of ['packages/shared', 'apps/web']) {
    const pkg = JSON.parse(readFileSync(join(root, packageName, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };

    expect(Object.keys(pkg.dependencies)).not.toEqual(expect.arrayContaining(['openai']));
    expect(Object.keys(pkg.dependencies).some((name) => name.startsWith('@aws-sdk/') || name === '@bid/api')).toBe(false);
  }
});

it('imports real compiled ESM package exports', async () => {
  const packageFile = JSON.parse(readFileSync(join(root, 'packages/shared/package.json'), 'utf8')) as { exports: { '.': { import: string } } };
  const contract = await import(pathToFileURL(join(root, 'packages/shared', packageFile.exports['.'].import)).href) as {
    PeriodInputSchema: { safeParse: (value: unknown) => { success: boolean } };
  };

  expect(contract.PeriodInputSchema.safeParse({ startDate: '2026-01-01', endDate: '2026-01-02' }).success).toBe(true);
});

it('does not put a synthetic server model key or private URL into bundled web assets', () => {
  const output = mkdtempSync(join(tmpdir(), 'bid-web-secret-check-'));
  const sentinel = 'SERVER_ONLY_MODEL_KEY_SENTINEL_21d59b61';
  const privateUrl = 'https://private-model-sentinel.invalid/v1';

  try {
    execFileSync(process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'build', '--outDir', output, '--emptyOutDir'], {
      cwd: join(root, 'apps/web'),
      env: { ...process.env, LLM_API_KEY: sentinel, LLM_BASE_URL: privateUrl },
      stdio: 'pipe', timeout: 30_000,
    });

    const builtFiles = files(output);

    expect(builtFiles.length).toBeGreaterThan(0);

    for (const file of builtFiles) {
      const asset = readFileSync(file, 'utf8');

      expect(asset, file).not.toContain(sentinel);
      expect(asset, file).not.toContain(privateUrl);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 35_000);
