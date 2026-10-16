import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type {
  ConfigurationPublication,
  ConfigurationWorkspace,
  SavedTurn,
} from '../../packages/shared/src/index.js';

test.skip(
  process.env.AGENT_E2E !== 'true' || !!process.env.PHASE3_TEST_PREFIX,
  'Requires mutable isolated fixture E2E services; never writes to persisted historical datasets.',
);

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Login', { exact: true }).fill('demo.a');
  await page.getByLabel('Password', { exact: true }).fill('isolated-browser-password-a');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByLabel('Applied dashboard filters')).toBeVisible();
  await page.getByRole('button', { name: 'Open agent', exact: true }).click();
  await expect(page.getByLabel('Message Bid Intelligence')).toBeVisible();
}

function conversationId(page: Page) {
  return new URLSearchParams(new URL(page.url()).hash.slice(1)).get('conversation')!;
}

async function workspace(page: Page): Promise<ConfigurationWorkspace> {
  const response = await page.request.get('/api/configurations/workspace');
  expect(response.ok()).toBe(true);
  return response.json();
}

async function send(page: Page, text: string) {
  await page.getByLabel('Message Bid Intelligence').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(
      async () => {
        const id = conversationId(page);
        if (!id) return null;
        const response = await page.request.get(`/api/conversations/${id}`);
        if (!response.ok()) return null;
        const { turns } = (await response.json()) as { turns: SavedTurn[] };
        const turn = turns.at(-1);
        return turn?.input === text ? turn.status : null;
      },
      { timeout: 35_000 },
    )
    .toBe('completed');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
}

async function restoreConversation(page: Page, id: string) {
  const { conversations } = (await (await page.request.get('/api/conversations')).json()) as {
    conversations: { id: string }[];
  };
  const index = conversations.findIndex((conversation) => conversation.id === id);
  expect(index).toBeGreaterThanOrEqual(0);
  await page.getByRole('button', { name: 'Chat history', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Chat history', exact: true })
    .locator('.history-item')
    .nth(index)
    .click();
  await expect(page).toHaveURL(new RegExp(`conversation=${id}`));
  await expect(page.getByText('Loading chat…', { exact: true })).toHaveCount(0);
}

test('agent review updates only the shared draft; human publication owns timestamped version with agent coauthor', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await login(page);
  const before = await workspace(page);
  const auth = await (await page.request.get('/api/auth/me')).json();
  const question =
    'mock:configuration-propose Review a supported floor change for the shared draft.';
  await send(page, question);
  const id = conversationId(page);
  const card = page.getByRole('region', { name: 'Configuration draft proposal' }).last();
  await expect(card.getByRole('button', { name: 'Update draft', exact: true })).toBeEnabled();
  await expect(card).toContainText('floors.data.values.banner');
  const pending = await workspace(page);
  expect(pending.current).toEqual(before.current);
  expect(pending.draft).toEqual(before.draft);
  expect(pending.proposal?.status).toBe('pending');
  await card.getByRole('button', { name: 'Update draft', exact: true }).click();
  await expect(card).toContainText('Draft updated — not published');
  const approved = await workspace(page);
  expect(approved.current).toEqual(before.current);
  expect(approved.draft?.agentContributed).toBe(true);
  expect(approved.draft?.prebid).toEqual(pending.proposal?.after);

  await page.getByRole('button', { name: 'Open shared draft', exact: true }).last().click();
  await expect(page).toHaveURL(/\/configurations\/draft/);
  await expect(page.getByRole('heading', { name: 'Shared draft', exact: true })).toBeVisible();
  await expect(page.locator('.user-message .message-text')).toContainText(question);
  expect(conversationId(page)).toBe(id);
  await page
    .locator('.configuration-editor')
    .getByRole('button', { name: 'Publish', exact: true })
    .click();
  const confirmation = page.getByRole('region', { name: 'Confirm publication' });
  await expect(confirmation).toContainText(auth.user.userId);
  await expect(confirmation).toContainText('Agent');
  await expect(confirmation).toContainText('unverified');
  const publishedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/configurations/publish') &&
      response.request().method() === 'POST',
  );
  await confirmation.getByRole('button', { name: 'Confirm publish', exact: true }).click();
  const published = (await (await publishedResponse).json()) as ConfigurationPublication;
  expect(published.authorUserId).toBe(auth.user.userId);
  expect(published.coauthor).toBe('agent');
  expect(published.versionId).toBe(published.publishedAt);
  expect(published.versionId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(published.prebid).toEqual(approved.draft?.prebid);
  await expect(page).toHaveURL(/\/configurations\/versions\//);
  await expect(page.locator('.configuration-version')).toContainText(`Author: ${auth.user.userId}`);
  await expect(page.locator('.configuration-version')).toContainText('Coauthor: Agent');
  await expect(page.locator('.user-message .message-text')).toContainText(question);
  expect(conversationId(page)).toBe(id);
  const after = await workspace(page);
  expect(after.draft).toBeNull();
  expect(after.current?.versionId).toBe(published.versionId);
  const screenshot = testInfo.outputPath('agent-authored-draft-human-publication.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Agent draft and human publication', {
    path: screenshot,
    contentType: 'image/png',
  });
});

test('rejected and stale agent cards cannot replace the newer shared draft or publish', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const before = await workspace(page);
  await send(page, 'mock:configuration-propose Prepare a floor change for rejection.');
  const rejectedCard = page.getByRole('region', { name: 'Configuration draft proposal' }).last();
  await expect(rejectedCard.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
  await rejectedCard.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(rejectedCard).toContainText('rejected');
  const rejected = await workspace(page);
  expect(rejected.draft).toEqual(before.draft);
  expect(rejected.current).toEqual(before.current);
  await expect(rejectedCard.getByRole('button', { name: 'Update draft', exact: true })).toHaveCount(
    0,
  );

  await send(
    page,
    'mock:configuration-propose Prepare a second change, then another editor will save.',
  );
  const staleCard = page.getByRole('region', { name: 'Configuration draft proposal' }).last();
  await expect(staleCard.getByRole('button', { name: 'Update draft', exact: true })).toBeEnabled();
  const pending = await workspace(page);
  const newer = structuredClone(pending.draft?.prebid ?? pending.current!.prebid);
  newer.setConfig.debug = !newer.setConfig.debug;
  const saved = await page.request.put('/api/configurations/draft', {
    headers: { Origin: new URL(page.url()).origin },
    data: { expectedRevision: pending.revision, prebid: newer },
  });
  expect(saved.ok()).toBe(true);
  const updated = (await saved.json()) as ConfigurationWorkspace;
  // Simulate an unseen second-tab save: the old card still has its original revision.
  await staleCard.getByRole('button', { name: 'Update draft', exact: true }).click();
  await expect(staleCard.getByRole('alert')).toBeVisible();
  await expect(staleCard.getByRole('button', { name: 'Update draft', exact: true })).toHaveCount(0);
  const after = await workspace(page);
  expect(after.draft).toEqual(updated.draft);
  expect(after.current).toEqual(before.current);
  const replay = await page.request.post('/api/configurations/proposal/decision', {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      proposalId: pending.proposal!.proposalId,
      expectedRevision: pending.revision,
      decision: 'approve',
    },
  });
  expect(replay.status()).toBe(409);
});

test('only requested safe navigation opens configuration pages; reload never replays it and chat stays available', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  await send(page, 'mock:configuration-read Inspect configuration without changing my page.');
  expect(new URL(page.url()).pathname).toBe('/');
  await send(page, 'mock:configuration-navigation Open the shared draft page.');
  await expect(page).toHaveURL(/\/configurations\/draft/);
  const id = conversationId(page);
  await expect(page.getByRole('heading', { name: 'Shared draft', exact: true })).toBeVisible();
  await expect(page.locator('.user-message .message-text')).toHaveCount(2);
  await page.getByLabel('Banner floor (USD CPM)', { exact: true }).fill('0.77');
  page.once('dialog', (dialog) => dialog.dismiss());
  await send(page, 'mock:configuration-navigation Open configuration history.');
  expect(new URL(page.url()).pathname).toBe('/configurations/draft');
  await expect(page.getByLabel('Banner floor (USD CPM)', { exact: true })).toHaveValue('0.77');
  await expect(page.locator('.user-message .message-text')).toHaveCount(3);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Publisher performance', exact: true }).click();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(conversationId(page)).toBe(id);
  await page.reload();
  await page.getByRole('button', { name: 'Open agent', exact: true }).click();
  await restoreConversation(page, id);
  await expect(page.locator('.user-message .message-text')).toHaveCount(3);
  expect(new URL(page.url()).pathname).toBe('/');
  await page.getByRole('button', { name: 'Open shared draft', exact: true }).last().click();
  await expect(page).toHaveURL(/\/configurations\/draft/);
  await expect(page.locator('.user-message .message-text')).toHaveCount(3);
  expect(conversationId(page)).toBe(id);
});
