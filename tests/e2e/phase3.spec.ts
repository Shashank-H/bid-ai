import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AuthResponse, SavedTurn } from '../../packages/shared/src/index.js';

type ConversationDetail = { turns: SavedTurn[] };

test.skip(
  process.env.AGENT_E2E !== 'true' || !process.env.PHASE3_TEST_PREFIX,
  'Requires an already-ready Phase 3 prefix and the persisted E2E server.',
);

const existingDemo = process.env.PHASE3_TEST_PREFIX === 'bid';
if (existingDemo) test.use({ trace: 'off' });

test.beforeAll(() => {
  if (
    existingDemo &&
    (process.env.PHASE3_READ_EXISTING_DATA !== 'true' ||
      !process.env.PHASE3_TEST_PASSWORD_A ||
      !process.env.PHASE3_TEST_PASSWORD_B)
  )
    throw new Error(
      'Existing bid data requires explicit read opt-in and both Phase 3 test passwords',
    );
});

async function login(page: Page, letter: 'a' | 'b') {
  await page.goto('/');
  await page.getByLabel('Login', { exact: true }).fill(`demo.${letter}`);
  const password =
    process.env[`PHASE3_TEST_PASSWORD_${letter.toUpperCase()}`] ||
    (existingDemo ? '' : `isolated-browser-password-${letter}`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByLabel('Applied dashboard filters')).toBeVisible();
  await page.getByRole('button', { name: 'Open agent', exact: true }).click();
  await expect(page.getByLabel('Message Bid Intelligence')).toBeVisible();
}

async function restoreConversation(page: Page, id: string) {
  const response = await page.request.get('/api/conversations');
  const { conversations } = (await response.json()) as { conversations: { id: string }[] };
  const index = conversations.findIndex((item) => item.id === id);
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

async function investigate(page: Page, question: string): Promise<SavedTurn> {
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByLabel('Message Bid Intelligence').fill(question);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await conversation(page))?.turns.at(-1)?.status).toBe('completed');
  const detail = await conversation(page);
  expect(detail).not.toBeNull();
  return detail!.turns.at(-1)!;
}

async function conversation(page: Page): Promise<ConversationDetail | null> {
  const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('conversation');
  if (!id) return null;
  const response = await page.request.get(`/api/conversations/${id}`);
  return response.ok() ? response.json() : null;
}

test('persisted floor investigation has real numeric evidence, exact coverage, reload and isolation', async ({
  page,
  browser,
}, testInfo) => {
  await login(page, 'a');
  const metadataResponse = await page.request.get('/api/auth/me');
  expect(metadataResponse.ok()).toBe(true);
  const metadata = (await metadataResponse.json()) as AuthResponse;
  expect(metadata.status).toBe('ready');
  expect(metadata.availablePeriod).toEqual({ startDate: '2026-08-24', endDate: '2026-10-19' });
  expect(metadata.observedFrom).toBe('2026-08-24T03:30:00.000Z');
  expect(metadata.observedThrough).toBe('2026-10-19T03:30:00.000Z');
  expect(metadata.partialDates).toEqual(['2026-08-24', '2026-10-19']);
  expect(metadata.lastCompleteDate).toBe('2026-10-18');
  const applied = page.getByLabel('Applied dashboard filters');
  await expect(applied).toContainText('2026-10-12 – 2026-10-18 UTC');
  const initialFilters = (await applied.textContent())!;
  await expect(page.locator('.dashboard-data-note')).toContainText('Synthetic observations');

  const turn = await investigate(
    page,
    'What changed after the floor update? Compare September 7–13 with September 14–20.',
  );
  expect(turn.tools.map((tool) => tool.name).sort()).toEqual([
    'compare_periods',
    'configuration_history',
    'current_configuration',
  ]);
  const comparison = turn.tools.find((tool) => tool.name === 'compare_periods')!.result!;
  const history = turn.tools.find((tool) => tool.name === 'configuration_history')!.result!;
  const data = comparison.data as {
    previous: { estimatedRevenue: number };
    current: { estimatedRevenue: number };
  };
  const change = (
    history.data as {
      history: {
        before: { floorCpm: number };
        after: { floorCpm: number };
        afterPrebid: unknown;
      }[];
    }
  ).history.at(-1)!;
  expect(data.previous.estimatedRevenue).toBeGreaterThan(data.current.estimatedRevenue);
  expect(change.after.floorCpm).toBeGreaterThan(change.before.floorCpm);
  expect(change.afterPrebid).toBeTruthy();
  await expect(page.locator('.assistant-message .message-text')).toContainText(
    `Estimated revenue changed from $${data.previous.estimatedRevenue.toFixed(2)} to $${data.current.estimatedRevenue.toFixed(2)}`,
  );
  await expect(page.locator('.assistant-message .message-text')).toContainText(
    `floor changed from $${change.before.floorCpm.toFixed(2)} to $${change.after.floorCpm.toFixed(2)}`,
  );
  await expect(page.locator('.tool-diagnostics')).toHaveCount(3);
  await expect(applied).toHaveText(initialFilters);
  await page
    .getByRole('link')
    .filter({ hasText: comparison.evidence[0]!.evidenceId })
    .first()
    .click();
  const comparisonCard = page.locator('.evidence-card').filter({
    has: page.getByRole('heading', { name: 'Estimated revenue comparison', exact: true }),
  });
  await expect(comparisonCard).toBeFocused();
  await expect(applied).toHaveText(initialFilters);
  await comparisonCard.getByRole('button', { name: 'Show in dashboard', exact: true }).click();
  await expect(applied).toContainText('2026-09-14 – 2026-09-20 UTC');
  await expect(applied).toContainText('vs 2026-09-07 – 2026-09-13 UTC');
  await expect(page.locator('.matching-records')).toContainText(
    '14 daily publisher metric records',
  );
  await expect(page.locator('.metric-tile').first()).toContainText(
    data.current.estimatedRevenue.toFixed(2),
  );
  const savedUrl = page.url();
  const id = new URLSearchParams(new URL(savedUrl).hash.slice(1)).get('conversation')!;
  await page.reload();
  await page.getByRole('button', { name: 'Open agent', exact: true }).click();
  await expect(page.locator('.messages .turn')).toHaveCount(0);
  await restoreConversation(page, id);
  await expect(page.locator('.tool-diagnostics')).toHaveCount(3);
  expect((await conversation(page))!.turns.at(-1)!.text).toBe(turn.text);
  expect(await page.content()).not.toMatch(
    /PRIVATE_|SCENARIO_MANIFEST|BROWSER_MODEL_KEY_SENTINEL|credentialHash/,
  );
  const screenshot = testInfo.outputPath('phase3-floor-desktop.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Persisted floor investigation', {
    path: screenshot,
    contentType: 'image/png',
  });

  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const publisherB = await other.newPage();
    await login(publisherB, 'b');
    const foreign = await other.request.get(`/api/conversations/${id}`);
    expect(foreign.status()).toBe(404);
    expect(await foreign.text()).not.toContain(turn.text);
    await publisherB.goto(savedUrl);
    await publisherB.getByRole('button', { name: 'Open agent', exact: true }).click();
    await expect(publisherB.locator('.messages .turn')).toHaveCount(0);
    await expect(publisherB.locator('.evidence-card')).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('persisted bidder investigation cites explicit period aggregates on a narrow viewport', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, 'b');
  const applied = page.getByLabel('Applied dashboard filters');
  const initialFilters = (await applied.textContent())!;
  const turn = await investigate(
    page,
    'Investigate Beacon bidder latency for October 5–18 against September 28–October 4.',
  );
  expect(turn.tools).toHaveLength(4);
  const bidderResult = turn.tools.find((tool) => {
    const data = tool.result?.data as { period?: { startDate: string } } | undefined;
    return tool.name === 'bidder_performance' && data?.period?.startDate === '2026-10-05';
  })!.result!;
  expect(bidderResult.evidence).toHaveLength(5);
  expect(
    bidderResult.evidence.every(
      (entry) => entry.referenceType === 'period-aggregate' && entry.publisherId === 'publisher-b',
    ),
  ).toBe(true);
  const beacon = bidderResult.evidence.find((entry) => entry.bidderId === 'beacon')!;
  expect(beacon.period).toEqual({ startDate: '2026-10-05', endDate: '2026-10-18' });
  await expect(page.locator('.assistant-message .message-text')).toContainText(
    'Beacon late-offer share changed',
  );
  await page.getByRole('link').filter({ hasText: beacon.evidenceId }).first().click();
  const card = page
    .locator('.evidence-card')
    .filter({ has: page.getByRole('heading', { name: 'beacon performance', exact: true }) })
    .filter({ hasText: '2026-10-05 – 2026-10-18 UTC' });
  await expect(card).toBeFocused();
  await expect(card).toContainText('2026-10-05 – 2026-10-18 UTC');
  await expect(card).toContainText('Bidders: beacon');
  await expect(applied).toHaveText(initialFilters);
  expect(beacon.analytics?.view).toEqual({
    kind: 'bidder-performance',
    metric: 'estimatedRevenue',
    period: { startDate: '2026-10-05', endDate: '2026-10-18' },
    bidderIds: ['beacon'],
  });
  await card.getByRole('button', { name: 'Show in dashboard', exact: true }).click();
  await expect(page.getByLabel('Message Bid Intelligence')).toHaveCount(0);
  await expect(applied).toContainText('2026-10-05 – 2026-10-18 UTC');
  await expect(applied).toContainText('beacon');
  await expect(page.locator('.matching-records')).toContainText('14 daily bidder metric records');
  await expect(page.locator('.matching-records tbody tr')).toHaveCount(14);
  await expect(page.locator('.matching-records tbody tr td:nth-child(2)')).toHaveText(
    Array(14).fill('beacon'),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const screenshot = testInfo.outputPath('phase3-bidder-mobile.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Persisted bidder period evidence', {
    path: screenshot,
    contentType: 'image/png',
  });
});
