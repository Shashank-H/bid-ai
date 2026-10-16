import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { SavedTurn } from '../../packages/shared/src/index.js';

test.skip(
  process.env.AGENT_E2E !== 'true',
  'Requires isolated compose.e2e.yaml services, never demo user passwords.',
);

async function openAgent(page: Page) {
  await page.getByRole('button', { name: 'Open agent', exact: true }).click();
  await expect(page.getByLabel('Message Bid Intelligence')).toBeVisible();
}

async function login(page: Page, letter = 'a') {
  await page.goto('/');
  await page.getByLabel('Login', { exact: true }).fill(`demo.${letter}`);
  await page.getByLabel('Password', { exact: true }).fill(`isolated-browser-password-${letter}`);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByLabel('Applied dashboard filters')).toBeVisible();
  await expect(page.getByLabel('Message Bid Intelligence')).toHaveCount(0);
  await openAgent(page);
}

function conversationId(page: Page) {
  return new URLSearchParams(new URL(page.url()).hash.slice(1)).get('conversation')!;
}

async function expectCompleted(page: Page, id?: string) {
  await expect
    .poll(
      async () => {
        const currentId = id ?? conversationId(page);
        if (!currentId) return null;
        const response = await page.request.get(`/api/conversations/${currentId}`);
        if (!response.ok()) return null;
        return ((await response.json()) as { turns: SavedTurn[] }).turns.at(-1)?.status;
      },
      { timeout: 35_000 },
    )
    .toBe('completed');
}

async function restoreConversation(page: Page, id: string) {
  const response = await page.request.get('/api/conversations');
  const { conversations } = (await response.json()) as { conversations: { id: string }[] };
  const index = conversations.findIndex((conversation) => conversation.id === id);
  expect(index).toBeGreaterThanOrEqual(0);
  await page.getByRole('button', { name: 'Chat history', exact: true }).click();
  const items = page
    .getByRole('navigation', { name: 'Chat history', exact: true })
    .locator('.history-item');
  await expect(items).toHaveCount(conversations.length);
  await items.nth(index).click();
  await expect(page).toHaveURL(new RegExp(`conversation=${id}`));
  await expect(page.getByText('Loading chat…', { exact: true })).toHaveCount(0);
}

async function send(page: Page, question: string) {
  await page.getByLabel('Message Bid Intelligence').fill(question);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('opening the agent and repeated New chat remain unsaved drafts; history restores only explicitly', async ({
  page,
  context,
}) => {
  const creations: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/conversations')
      creations.push(request.url());
  });
  await login(page);
  const baseline = (await (await context.request.get('/api/conversations')).json()).conversations
    .length;
  await page.getByLabel('Message Bid Intelligence').fill('An unsent draft');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByLabel('Message Bid Intelligence')).toHaveValue('');
  await page.getByRole('button', { name: 'Close agent panel', exact: true }).click();
  await openAgent(page);
  await expect(page.locator('.messages .turn')).toHaveCount(0);
  await page.reload();
  await openAgent(page);
  expect(creations).toHaveLength(0);
  expect(
    (await (await context.request.get('/api/conversations')).json()).conversations,
  ).toHaveLength(baseline);

  await send(page, 'What changed in my performance? Draft lifecycle');
  await expect(page.locator('.assistant-message .message-text')).toContainText(
    'Estimated revenue changed from $63.00 to $50.40',
  );
  await expectCompleted(page);
  const id = conversationId(page);
  expect(creations).toHaveLength(1);
  await page.reload();
  await openAgent(page);
  await expect(page.locator('.messages .turn')).toHaveCount(0);
  await restoreConversation(page, id);
  await expect(page.locator('.user-message .message-text')).toContainText('Draft lifecycle');
  expect(creations).toHaveLength(1);
});

test('real multi-tool evidence changes dashboard filters only on request and survives history restoration', async ({
  page,
  context,
  browser,
}, testInfo) => {
  await login(page);
  const applied = page.getByLabel('Applied dashboard filters');
  const initialFilters = (await applied.textContent())!;
  await send(page, 'What changed in my performance? Dashboard evidence');
  await expectCompleted(page);
  await expect(page.locator('.assistant-message .message-text')).toContainText(
    'Estimated revenue changed from $63.00 to $50.40',
  );
  await expect(page.locator('.tool-diagnostics')).toHaveCount(3);
  await expect(applied).toHaveText(initialFilters);
  const id = conversationId(page);
  const detail = (await (await page.request.get(`/api/conversations/${id}`)).json()) as {
    turns: SavedTurn[];
  };
  const comparison = detail.turns
    .at(-1)!
    .tools.find((tool) => tool.name === 'compare_periods')!.result!;
  const evidenceId = comparison.evidence[0]!.evidenceId;
  expect(evidenceId).toMatch(/^e\d+$/);
  const card = page.locator('.evidence-card').filter({
    has: page.getByRole('button', { name: 'Estimated revenue comparison', exact: true }),
  });
  await page
    .getByRole('link', { name: `[${evidenceId}]`, exact: true })
    .first()
    .click();
  await expect(
    card.getByRole('button', { name: 'Estimated revenue comparison', exact: true }),
  ).toBeFocused();
  await expect(
    card.getByRole('dialog', { name: 'Estimated revenue comparison', exact: true }),
  ).toBeVisible();
  await expect(applied).toHaveText(initialFilters);
  await expect(card).toContainText('2026-01-01');
  await card.getByRole('button', { name: 'Show in dashboard', exact: true }).click();
  await expect(applied).toContainText('2026-01-08 – 2026-01-14 UTC');
  await expect(applied).toContainText('vs 2026-01-01 – 2026-01-07 UTC');
  await expect(page.locator('.metric-tile').first()).toContainText('$50.40');
  await expect(page.locator('.matching-records')).toContainText(
    '14 daily publisher metric records',
  );
  await expect(page.locator('.matching-records tbody tr')).toHaveCount(14);
  const rail = await page.getByRole('navigation', { name: 'Workspace', exact: true }).boundingBox();
  const dashboard = await page.locator('.dashboard-main').boundingBox();
  const agent = await page.locator('.agent-slot').boundingBox();
  expect(rail!.x + rail!.width).toBeLessThanOrEqual(dashboard!.x);
  expect(dashboard!.x + dashboard!.width).toBeLessThanOrEqual(agent!.x);
  const screenshot = testInfo.outputPath('dashboard-evidence-desktop.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Dashboard and evidence', { path: screenshot, contentType: 'image/png' });

  await page.reload();
  await openAgent(page);
  await restoreConversation(page, id);
  await expect(card).toContainText('Estimated revenue comparison');
  await card.getByRole('button', { name: 'Estimated revenue comparison', exact: true }).click();
  await expect(
    card.getByRole('dialog', { name: 'Estimated revenue comparison', exact: true }),
  ).toBeVisible();
  await card.getByRole('button', { name: 'Show in dashboard', exact: true }).click();
  await expect(applied).toContainText('vs 2026-01-01 – 2026-01-07 UTC');
  expect(await page.content()).not.toMatch(
    /PRIVATE_|BROWSER_MODEL_KEY_SENTINEL|credentialHash|channel_values/,
  );

  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const publisherB = await other.newPage();
    await login(publisherB, 'b');
    expect((await other.request.get(`/api/conversations/${id}`)).status()).toBe(404);
    await publisherB.goto(`${new URL(page.url()).origin}/#conversation=${id}`);
    // A hash-only navigation does not remount the workspace or close the open panel.
    await publisherB.reload();
    await openAgent(publisherB);
    await expect(publisherB.locator('.messages .turn')).toHaveCount(0);
    await expect(publisherB.locator('.evidence-card')).toHaveCount(0);
  } finally {
    await other.close();
  }
  await page
    .getByRole('navigation', { name: 'Workspace', exact: true })
    .getByRole('button', { name: 'Log out', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Publisher login' })).toBeVisible();
  expect((await context.request.get(`/api/conversations/${id}`)).status()).toBe(401);
});

test('Stop cancels upstream work and persists cancellation; untrusted citations fail visibly', async ({
  page,
}) => {
  await login(page);
  await send(page, 'mock:slow');
  await expect(page.locator('.assistant-message .message-text')).toContainText(
    'Waiting for the demo investigation',
  );
  const id = conversationId(page);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.turn-status')).toContainText('cancelled · incomplete response');
  await page.reload();
  await openAgent(page);
  await restoreConversation(page, id);
  await expect(page.locator('.turn-status')).toContainText('cancelled · incomplete response');
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await send(page, 'mock:fake-citation');
  await expect(page.locator('.turn-status').last()).toContainText('error · incomplete response');
});

test('closing the agent detaches streaming but backend work completes in its original history', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const filters = (await page.getByLabel('Applied dashboard filters').textContent())!;
  await send(page, 'mock:slow complete after closing panel');
  await expect(page.locator('.assistant-message .message-text')).toContainText(
    'Waiting for the demo investigation',
  );
  const id = conversationId(page);
  await page.getByRole('button', { name: 'Close agent panel', exact: true }).click();
  await openAgent(page);
  await expect(page.locator('.messages .turn')).toHaveCount(0);
  await expect(page.getByLabel('Message Bid Intelligence')).toBeEnabled();
  await expectCompleted(page, id);
  await restoreConversation(page, id);
  await expect(page.locator('.assistant-message .message-text')).toContainText(
    'Estimated revenue changed from $63.00 to $50.40',
  );
  await expect(page.locator('.turn-status')).toHaveCount(0);
  await expect(page.getByLabel('Applied dashboard filters')).toHaveText(filters);
});

test('streaming tool updates do not pull a reader away from earlier messages', async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1280, height: 650 });
  await login(page);
  await send(
    page,
    `mock:slow\n${'Please investigate auction performance with supporting evidence.\n'.repeat(70)}`,
  );
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
  await expect(page.locator('.tool-diagnostics')).toHaveCount(3, { timeout: 20_000 });
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeLessThan(10);
  await page.locator('.composer').getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.turn-status')).toContainText('cancelled · incomplete response');
});

test('mobile agent history, multiline composer and explicit dashboard evidence remain accessible', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  const historyToggle = page.getByRole('button', { name: 'Chat history', exact: true });
  await historyToggle.focus();
  await historyToggle.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Chat history', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to chat', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Chat history', exact: true })).toHaveCount(0);
  await expect(historyToggle).toBeFocused();
  const question = page.getByLabel('Message Bid Intelligence');
  await question.fill('What changed');
  await question.press('Shift+Enter');
  await question.pressSequentially('in my performance?');
  await expect(question).toHaveValue('What changed\nin my performance?');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
  await question.press('Enter');
  await expectCompleted(page);
  const id = conversationId(page);
  await expect(page.locator('.user-message .message-text')).toContainText(
    'What changed\nin my performance?',
  );
  const card = page.locator('.evidence-card').filter({
    has: page.getByRole('button', { name: 'Estimated revenue comparison', exact: true }),
  });
  await card.getByRole('button', { name: 'Estimated revenue comparison', exact: true }).click();
  await expect(
    card.getByRole('dialog', { name: 'Estimated revenue comparison', exact: true }),
  ).toBeVisible();
  await card.getByRole('button', { name: 'Show in dashboard', exact: true }).click();
  await expect(page.getByLabel('Message Bid Intelligence')).toHaveCount(0);
  await expect(page.getByLabel('Applied dashboard filters')).toContainText(
    'vs 2026-01-01 – 2026-01-07 UTC',
  );
  await expect(page.locator('.matching-records tbody tr')).toHaveCount(14);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const screenshot = testInfo.outputPath('dashboard-evidence-mobile.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Mobile evidence dashboard', {
    path: screenshot,
    contentType: 'image/png',
  });
  await openAgent(page);
  await expect(page.locator('.messages .turn')).toHaveCount(0);
  await restoreConversation(page, id);
  await expect(card).toBeVisible();
  for (const width of [768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(question).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});

test('bidder filters apply explicitly and pagination exposes every matching daily record', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Close agent panel', exact: true }).click();
  await page.getByRole('button', { name: 'Bidder performance', exact: true }).click();
  await page.getByLabel('Start date (UTC)', { exact: true }).fill('2026-01-01');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('.matching-records')).toContainText('28 daily bidder metric records');
  await expect(page.locator('.matching-records tbody tr')).toHaveCount(20);
  const total = (await page.locator('.metric-tile').first().locator('strong').textContent())!;
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.records-pagination')).toContainText('Page 2 of 2');
  await expect(page.locator('.matching-records tbody tr')).toHaveCount(8);
  await expect(page.locator('.metric-tile').first().locator('strong')).toHaveText(total);
  await page.getByLabel('atlas', { exact: true }).check();
  await expect(page.getByLabel('Applied dashboard filters')).toContainText('All bidders');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByLabel('Applied dashboard filters')).toContainText('atlas');
  await expect(page.locator('.matching-records')).toContainText('14 daily bidder metric records');
  await expect(page.locator('.matching-records tbody tr')).toHaveCount(14);
  await expect(page.locator('.matching-records tbody tr td:nth-child(2)')).toHaveText(
    Array(14).fill('atlas'),
  );
});

test('dark theme persists across dashboard reload and agent open/close', async ({
  page,
}, testInfo) => {
  await login(page);
  await page.getByRole('button', { name: 'Close agent panel', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.recharts-surface[role="application"]')).toBeVisible();
  expect(
    await page
      .locator('.dashboard-main')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe(
    await page.locator('html').evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await openAgent(page);
  expect(
    await page
      .locator('.agent-chat')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe(
    await page.locator('html').evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  const screenshot = testInfo.outputPath('dashboard-dark-theme.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Dark dashboard and agent', { path: screenshot, contentType: 'image/png' });
});
