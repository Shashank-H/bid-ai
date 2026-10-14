import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.skip(
  process.env.AGENT_E2E !== 'true',
  'Requires isolated compose.e2e.yaml services, never demo user passwords.',
);

async function login(page: Page, letter = 'a') {
  await page.goto('/');
  await page.getByLabel('Login', { exact: true }).fill(`demo.${letter}`);
  await page.getByLabel('Password', { exact: true }).fill(`isolated-browser-password-${letter}`);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByLabel('Message Bid Intelligence')).toBeVisible();
}

async function expectCompleted(page: Page) {
  await expect
    .poll(async () => {
      const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('conversation');
      if (!id) return null;
      const response = await page.request.get(`/api/conversations/${id}`);
      if (!response.ok()) return null;
      const body = (await response.json()) as { turns: { status: string }[] };
      return body.turns.at(-1)?.status;
    })
    .toBe('completed');
  await expect(page.getByLabel('Message Bid Intelligence')).toBeEnabled();
}

test('New remains an unsaved draft until the first Send, including repeated New and reload', async ({
  page,
  context,
}) => {
  const creationRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/conversations')
      creationRequests.push(request.url());
  });
  await login(page);
  async function savedIds(): Promise<string[]> {
    const response = await context.request.get('/api/conversations');
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { conversations: { id: string }[] };
    return body.conversations.map((conversation) => conversation.id).sort();
  }
  const baseline = await savedIds();
  const historyItems = page
    .getByRole('navigation', { name: 'Chat history', exact: true })
    .locator('li');
  await expect(historyItems).toHaveCount(baseline.length);
  const question = page.getByLabel('Message Bid Intelligence');
  await expect(question).toBeVisible();
  await question.fill('An unsent draft');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(question).toHaveValue('');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.reload();
  await expect(question).toBeVisible();
  await expect(historyItems).toHaveCount(baseline.length);
  expect(new URL(page.url()).hash).toBe('');
  expect(creationRequests).toHaveLength(0);
  expect(await savedIds()).toEqual(baseline);

  const composer = page.locator('.composer');
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await expect(composer.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  await question.fill('What changed in my performance?');
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.assistant-message .message-text')).toContainText(
    'Estimated revenue changed from $63.00 to $50.40',
  );
  await expectCompleted(page);
  expect(creationRequests).toHaveLength(1);
  const afterSend = await savedIds();
  expect(afterSend).toHaveLength(baseline.length + 1);
  const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('conversation');
  expect(id).toBeTruthy();
  expect(afterSend).toContain(id);
  await expect(historyItems).toHaveCount(afterSend.length);
  await page.reload();
  await expect(page.locator('.message-text').first()).toContainText(
    'What changed in my performance?',
  );
  await expect(historyItems).toHaveCount(afterSend.length);
  expect(await savedIds()).toEqual(afterSend);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.locator('.messages .turn')).toHaveCount(0);
  await page.reload();
  await expect(question).toBeVisible();
  await expect(historyItems).toHaveCount(afterSend.length);
  expect(creationRequests).toHaveLength(1);
  expect(await savedIds()).toEqual(afterSend);
});

test('real proxy login → real multi-tools → cited stream → persistent reload and publisher isolation/logout', async ({
  page,
  context,
  browser,
}, testInfo) => {
  await login(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Message Bid Intelligence').fill('What changed in my performance?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expectCompleted(page);
  await expect(page.locator('.message-text')).toContainText([
    'What changed in my performance?',
    'Estimated revenue changed from $63.00 to $50.40',
  ]);
  await expect(page.locator('.activity-panel .tool-card')).toHaveCount(3);
  await expect(page.locator('.chat-panel .tool-card')).toHaveCount(0);
  const historyBounds = await page.locator('.history-panel').boundingBox();
  const chatBounds = await page.locator('.chat-panel').boundingBox();
  const activityBounds = await page.locator('.activity-panel').boundingBox();
  expect(historyBounds!.x + historyBounds!.width).toBeLessThanOrEqual(chatBounds!.x);
  expect(chatBounds!.x + chatBounds!.width).toBeLessThanOrEqual(activityBounds!.x);
  const screenshot = testInfo.outputPath('chat-desktop.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Desktop chat', { path: screenshot, contentType: 'image/png' });
  const link = page.getByRole('link').filter({ hasText: 'publisher-a-daily-metrics' }).first();
  await link.click();
  await expect(page.locator('.evidence[open]').first()).toContainText('Evidence ID');
  const url = page.url();
  const id = new URLSearchParams(new URL(url).hash.slice(1)).get('conversation')!;
  await page.reload();
  await expectCompleted(page);
  await expect(page.locator('.tool-card')).toHaveCount(3);
  expect(await page.content()).not.toMatch(
    /PRIVATE_|BROWSER_MODEL_KEY_SENTINEL|credentialHash|channel_values/,
  );

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

test('Stop cancels an actual upstream stream and persists the partial state; untrusted citations fail visibly', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Message Bid Intelligence').fill('mock:slow');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await expect(page.locator('.message-text').last()).toContainText(
    'Waiting for the demo investigation',
  );
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.turn-status')).toContainText('cancelled · incomplete response');
  await page.reload();
  await expect(page.locator('.turn-status')).toContainText('cancelled · incomplete response');
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await page.getByLabel('Message Bid Intelligence').fill('mock:fake-citation');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.turn-status').last()).toContainText('error · incomplete response');
  await expect(page.locator('.turn-status').last()).toContainText('incomplete response');
});

test('streaming tool updates do not pull a reader away from earlier messages', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 650 });
  await login(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page
    .getByLabel('Message Bid Intelligence')
    .fill(
      `mock:slow\n${'Please investigate the auction performance with supporting evidence.\n'.repeat(70)}`,
    );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.assistant-message .message-text')).toContainText(
    'Waiting for the demo investigation',
  );
  const scroll = page.locator('.chat-scroll');
  expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('.activity-panel .tool-card')).toHaveCount(3, { timeout: 20_000 });
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeLessThan(10);
  await page.locator('.composer').getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.turn-status')).toContainText('cancelled · incomplete response');
});

test('mobile history and activity disclosures keep the multiline composer and tools accessible', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  const history = page.locator('.history-panel');
  const activity = page.locator('.activity-panel');
  const question = page.getByLabel('Message Bid Intelligence');
  await expect(history).not.toHaveAttribute('open');
  await expect(activity).not.toHaveAttribute('open');
  await expect(page.getByRole('button', { name: 'New', exact: true })).not.toBeVisible();
  const historyToggle = history.locator('summary').first();
  await historyToggle.focus();
  await historyToggle.press('Enter');
  await expect(history).toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(history).not.toHaveAttribute('open');
  await expect(question).toBeFocused();
  await expect(question).toBeInViewport();
  await question.fill('What changed');
  await question.press('Shift+Enter');
  await question.pressSequentially('in my performance?');
  await expect(question).toHaveValue('What changed\nin my performance?');
  const composer = page.locator('.composer');
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
  await expect(composer.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const draftScreenshot = testInfo.outputPath('chat-mobile-draft.png');
  await page.screenshot({ path: draftScreenshot, fullPage: true });
  await testInfo.attach('Mobile draft', { path: draftScreenshot, contentType: 'image/png' });
  await question.press('Enter');
  await expectCompleted(page);
  await expect(page.locator('.user-message .message-text')).toContainText(
    'What changed\nin my performance?',
  );
  await expect(page.locator('.assistant-message .message-text')).toContainText(
    'Estimated revenue changed from $63.00 to $50.40',
  );
  const activityToggle = activity.locator('summary').first();
  await activityToggle.focus();
  await activityToggle.press('Enter');
  await expect(activity).toHaveAttribute('open', '');
  await expect(activity.locator('.tool-card')).toHaveCount(3);
  await expect(activity.locator('.tool-card').first()).toBeVisible();
  const evidenceLink = page
    .getByRole('link')
    .filter({ hasText: 'publisher-a-daily-metrics' })
    .first();
  await evidenceLink.click();
  await expect(activity.locator('.evidence[open]').first()).toContainText('Evidence ID');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const activityScreenshot = testInfo.outputPath('chat-mobile-activity.png');
  await page.screenshot({ path: activityScreenshot, fullPage: true });
  await testInfo.attach('Mobile activity', { path: activityScreenshot, contentType: 'image/png' });
  for (const width of [768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(question).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});
