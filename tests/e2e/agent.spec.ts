import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.skip(process.env.AGENT_E2E !== 'true', 'Requires isolated compose.e2e.yaml services, never demo user passwords.');

async function login(page: Page, letter = 'a') {
  await page.goto('/');
  await page.getByLabel('Login', { exact: true }).fill(`demo.${letter}`);
  await page.getByLabel('Password', { exact: true }).fill(`isolated-browser-password-${letter}`);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved investigations' })).toBeVisible();
}

test('real proxy login → real multi-tools → cited stream → persistent reload and publisher isolation/logout', async ({ page, context, browser }) => {
  await login(page);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByLabel('Ask about your auction performance').fill('What changed in my performance?');
  await page.getByRole('button', { name: 'Investigate', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Investigation · completed' })).toBeVisible();
  await expect(page.locator('.message-text')).toContainText(['What changed in my performance?', 'Estimated revenue changed from $63.00 to $50.40']);
  await expect(page.locator('.tool-card')).toHaveCount(3);
  const link = page.getByRole('link').filter({ hasText: 'publisher-a-daily-metrics' }).first();
  await link.click();
  await expect(page.locator('.evidence[open]').first()).toContainText('Evidence ID');
  const url = page.url();
  const id = new URLSearchParams(new URL(url).hash.slice(1)).get('conversation')!;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Investigation · completed' })).toBeVisible();
  await expect(page.locator('.tool-card')).toHaveCount(3);
  expect(await page.content()).not.toMatch(/PRIVATE_|BROWSER_MODEL_KEY_SENTINEL|credentialHash|channel_values/);

  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const publisherB = await other.newPage();
  await login(publisherB, 'b');
  const foreign = await other.request.get(`/api/conversations/${id}`);
  expect(foreign.status()).toBe(404);
  await publisherB.goto(url);
  await publisherB.reload();
  await expect(publisherB.getByRole('alert')).toContainText('not found');
  await expect(publisherB.locator('.tool-card')).toHaveCount(0);
  await other.close();

  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Publisher login' })).toBeVisible();
  expect((await context.request.get(`/api/conversations/${id}`)).status()).toBe(401);
  await expect(page.locator('.tool-card')).toHaveCount(0);
});

test('Stop cancels an actual upstream stream and persists the partial state; untrusted citations fail visibly', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByLabel('Ask about your auction performance').fill('mock:slow');
  await page.getByRole('button', { name: 'Investigate', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await expect(page.locator('.message-text').last()).toContainText('Waiting for the demo investigation');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Investigation · cancelled' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Investigation · cancelled' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume investigation' })).toHaveCount(0);
  await page.getByLabel('Ask about your auction performance').fill('mock:fake-citation');
  await page.getByRole('button', { name: 'Investigate', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Investigation · error' })).toBeVisible();
  await expect(page.getByText('Incomplete / provisional', { exact: false })).not.toHaveCount(0);
});
