import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  AuthResponseSchema,
  ConfigurationPublicationSchema,
  ConfigurationVersionPageSchema,
  ConfigurationWorkspaceSchema,
} from '../../packages/shared/src/index.js';
import type { ConfigurationPublication, SavedTurn } from '../../packages/shared/src/index.js';

test.skip(
  process.env.AGENT_E2E !== 'true' || !!process.env.PHASE3_TEST_PREFIX,
  'Configuration writes require the isolated fixture E2E server, never persisted/demo datasets.',
);

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Login', { exact: true }).fill('demo.a');
  await page.getByLabel('Password', { exact: true }).fill('isolated-browser-password-a');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByLabel('Applied dashboard filters')).toBeVisible();
}

async function workspace(page: Page) {
  const response = await page.request.get('/api/configurations/workspace');
  expect(response.ok()).toBe(true);
  return ConfigurationWorkspaceSchema.parse(await response.json());
}

async function publications(page: Page) {
  const versions: ConfigurationPublication[] = [];
  let cursor: string | null = null;
  do {
    const response = await page.request.get(
      `/api/configurations/versions?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(response.ok()).toBe(true);
    const result = ConfigurationVersionPageSchema.parse(await response.json());
    versions.push(...result.versions);
    cursor = result.nextCursor;
  } while (cursor);
  return versions;
}

async function openConfigurations(page: Page) {
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'Configurations', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Current configuration', exact: true }),
  ).toBeVisible();
}

async function openDraft(page: Page) {
  await openConfigurations(page);
  await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shared draft', exact: true })).toBeVisible();
}

async function saveDraft(page: Page) {
  const response = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname === '/api/configurations/draft' &&
      result.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  const result = await response;
  expect(result.ok()).toBe(true);
  await expect(
    page.getByText('Shared draft saved. Published configuration is unchanged.', { exact: true }),
  ).toBeVisible();
  return ConfigurationWorkspaceSchema.parse(await result.json());
}

function differentFloor(current: number) {
  return current === 0.91 ? '0.92' : '0.91';
}

function versionPath(version: ConfigurationPublication) {
  return `/configurations/versions/${encodeURIComponent(version.versionId)}`;
}

test('one shared draft is repeatedly saved; publishing creates a dated immutable version and old versions restore through the draft', async ({
  page,
}) => {
  await login(page);
  const authResponse = await page.request.get('/api/auth/me');
  const auth = AuthResponseSchema.parse(await authResponse.json());
  const before = await workspace(page);
  expect(before.current).not.toBeNull();
  const old = before.current!;
  const oldSnapshot = JSON.stringify(old);
  const priorVersions = await publications(page);

  await openDraft(page);
  const floor = page.getByLabel('Banner floor (USD CPM)', { exact: true });
  await floor.fill(
    differentFloor(
      before.draft?.prebid.setConfig.floors.data.values.banner ?? old.settings.floorCpm,
    ),
  );
  const first = await saveDraft(page);
  expect(first.revision).toBeGreaterThan(before.revision);
  expect(first.current).toEqual(before.current);
  expect(first.draft).not.toBeNull();
  expect(await publications(page)).toEqual(priorVersions);

  await floor.fill(
    first.draft!.prebid.setConfig.floors.data.values.banner === 0.93 ? '0.94' : '0.93',
  );
  const second = await saveDraft(page);
  expect(second.revision).toBeGreaterThan(first.revision);
  expect(second.draft!.prebid).not.toEqual(first.draft!.prebid);
  expect(second.current).toEqual(before.current);
  expect(await publications(page)).toEqual(priorVersions);

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const confirmation = page.getByRole('region', { name: 'Confirm publication', exact: true });
  await expect(confirmation).toContainText(`Author: ${auth.user.userId}`);
  await expect(confirmation).toContainText('Performance is unverified.');
  await expect(confirmation).toContainText('does not deploy to a live website');
  await confirmation.getByText('Exact saved configuration to publish', { exact: true }).click();
  await expect(confirmation.locator('pre')).toHaveText(
    JSON.stringify(second.draft!.prebid, null, 2),
  );
  const publishResponse = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname === '/api/configurations/publish' &&
      result.request().method() === 'POST',
  );
  await confirmation.getByRole('button', { name: 'Confirm publish', exact: true }).click();
  const response = await publishResponse;
  expect(response.ok()).toBe(true);
  const published = ConfigurationPublicationSchema.parse(await response.json());
  expect(published.authorUserId).toBe(auth.user.userId);
  expect(published.versionId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(published.versionId).toBe(published.publishedAt);
  expect(published.prebid).toEqual(second.draft!.prebid);
  expect(published.coauthor).toBe(second.draft!.agentContributed ? 'agent' : undefined);
  await expect(page).toHaveURL(
    new RegExp(`/configurations/versions/${encodeURIComponent(published.versionId)}$`),
  );
  await expect(
    page.getByRole('heading', { name: `Published ${published.publishedAt}`, exact: true }),
  ).toBeVisible();
  const after = await workspace(page);
  expect(after.current).toEqual(published);
  expect(after.draft).toBeNull();
  expect(await publications(page)).toHaveLength(priorVersions.length + 1);

  const unchanged = await page.request.get(
    `/api/configurations/versions/${encodeURIComponent(old.versionId)}`,
  );
  expect(unchanged.ok()).toBe(true);
  expect(JSON.stringify(ConfigurationPublicationSchema.parse(await unchanged.json()))).toBe(
    oldSnapshot,
  );
  await page.goto(versionPath(old));
  await expect(
    page.getByRole('heading', { name: `Published ${old.publishedAt}`, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.configuration-document')).toHaveText(
    JSON.stringify(old.prebid, null, 2),
  );
  const restoreResponse = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname === '/api/configurations/draft' &&
      result.request().method() === 'PUT',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Use as draft', exact: true }).click();
  const restoredResponse = await restoreResponse;
  expect(restoredResponse.ok()).toBe(true);
  expect(restoredResponse.request().postDataJSON().sourceVersionId).toBe(old.versionId);
  await expect(page).toHaveURL(/\/configurations\/draft$/);
  const restored = await workspace(page);
  expect(restored.draft!.prebid).toEqual(old.prebid);
  expect(restored.draft!.agentContributed).toBe(old.coauthor === 'agent');
  expect(restored.current).toEqual(published);
  expect(await publications(page)).toHaveLength(priorVersions.length + 1);
});

test('invalid numeric controls and invalid JSON retain editable input and recover before saving', async ({
  page,
}, testInfo) => {
  await login(page);
  await openDraft(page);
  const timeout = page.getByLabel('Default timeout (ms)', { exact: true });
  const targetTimeout = (await timeout.inputValue()) === '1350' ? '1400' : '1350';
  const targetFloor =
    (await page.getByLabel('Banner floor (USD CPM)', { exact: true }).inputValue()) === '0.95'
      ? '0.96'
      : '0.95';
  await timeout.fill('');
  await expect(timeout).toBeVisible();
  await expect(timeout).toBeEnabled();
  await expect(timeout).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await timeout.fill(targetTimeout);
  const floor = page.getByLabel('Banner floor (USD CPM)', { exact: true });
  await floor.fill('');
  await expect(floor).toBeVisible();
  await expect(floor).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await floor.fill(targetFloor);
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'JSON', exact: true }).click();
  const json = page.getByRole('textbox', { name: 'Supported Prebid JSON', exact: true });
  const valid = await json.inputValue();
  const invalid = '{"setConfig":';
  await json.fill(invalid);
  await expect(page.getByRole('alert')).toContainText('Invalid JSON');
  await page.getByRole('tab', { name: 'Form', exact: true }).click();
  await expect(timeout).toBeVisible();
  await page.getByRole('tab', { name: 'JSON', exact: true }).click();
  await expect(json).toHaveValue(invalid);
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await json.fill(JSON.stringify({ ...JSON.parse(valid), unsupportedSetting: true }, null, 2));
  await expect(page.getByRole('alert')).toContainText('Configuration validation failed');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await json.fill(valid);
  await page.getByRole('tab', { name: 'Form', exact: true }).click();
  await expect(timeout).toHaveValue(targetTimeout);
  await expect(floor).toHaveValue(targetFloor);
  const saved = await saveDraft(page);
  expect(saved.draft!.prebid.setConfig.bidderTimeout).toBe(Number(targetTimeout));
  expect(saved.draft!.prebid.setConfig.floors.data.values.banner).toBe(Number(targetFloor));
  await expect(page.getByRole('alert')).toHaveCount(0);
  const screenshot = testInfo.outputPath('configuration-editor-desktop.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Shared draft editor', { path: screenshot, contentType: 'image/png' });
});

test('cancelled Back retains unsaved work without destroying Back and Forward destinations', async ({
  page,
}) => {
  await login(page);
  await openDraft(page);
  const floor = page.getByLabel('Banner floor (USD CPM)', { exact: true });
  await floor.fill(differentFloor(Number(await floor.inputValue())));
  const localValue = await floor.inputValue();
  const originalUrl = page.url();
  const originalIndex = await page.evaluate(() => window.history.state.workspaceIndex as number);
  const historyLength = await page.evaluate(() => window.history.length);
  const cancelled = page.waitForEvent('dialog');
  await page.evaluate(() => window.history.back());
  await (await cancelled).dismiss();
  await expect
    .poll(() => page.evaluate(() => window.history.state.workspaceIndex as number))
    .toBe(originalIndex);
  await expect(page).toHaveURL(originalUrl);
  await expect(floor).toHaveValue(localValue);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

  const accepted = page.waitForEvent('dialog');
  await page.evaluate(() => window.history.back());
  await (await accepted).accept();
  await expect(page).toHaveURL(/\/configurations$/);
  await expect(
    page.getByRole('heading', { name: 'Current configuration', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.history.forward());
  await expect(page).toHaveURL(originalUrl);
  await expect(page.getByRole('heading', { name: 'Shared draft', exact: true })).toBeVisible();
  expect(await floor.inputValue()).not.toBe(localValue);
});

test('configuration navigation preserves active chat and URL context; published deep links survive reload', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  await page.getByRole('button', { name: 'Open agent', exact: true }).click();
  const composer = page.getByLabel('Message Bid Intelligence');
  const question = 'What changed in my performance? Configuration page navigation';
  await composer.fill(question);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(
      async () => {
        const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('conversation');
        if (!id) return null;
        const response = await page.request.get(`/api/conversations/${id}`);
        if (!response.ok()) return null;
        return ((await response.json()) as { turns: SavedTurn[] }).turns.at(-1)?.status;
      },
      { timeout: 35_000 },
    )
    .toBe('completed');
  const hash = new URL(page.url()).hash;
  await composer.fill('Keep this unsent question while browsing configurations');
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('configuration-context', 'keep');
    window.history.replaceState(window.history.state, '', url);
  });
  await openConfigurations(page);
  await expect(page.locator('.user-message .message-text')).toContainText(question);
  await expect(composer).toHaveValue('Keep this unsent question while browsing configurations');
  expect(new URL(page.url()).hash).toBe(hash);
  expect(new URL(page.url()).searchParams.get('configuration-context')).toBe('keep');
  await page.getByRole('button', { name: 'Open current version', exact: true }).click();
  await expect(page.locator('.configuration-document')).toBeVisible();
  await expect(composer).toHaveValue('Keep this unsent question while browsing configurations');
  const current = (await workspace(page)).current!;
  const deepLink = page.url();
  expect(new URL(deepLink).pathname).toBe(versionPath(current));
  expect(new URL(deepLink).hash).toBe(hash);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: `Published ${current.publishedAt}`, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.configuration-document')).toHaveText(
    JSON.stringify(current.prebid, null, 2),
  );
  await expect(page).toHaveURL(deepLink);
});
