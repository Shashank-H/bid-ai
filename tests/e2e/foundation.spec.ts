import { expect, test } from '@playwright/test';

const sentinel = process.env.TEST_SECRET_SENTINEL ?? 'phase0-secret-sentinel-not-for-browser';

test('the production page reaches the API through its same-origin proxy', async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const readyResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/health/ready');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bid Intelligence', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('API and database resources are ready.');

  const response = await readyResponse;

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ready' });
  expect(new URL(response.url()).origin).toBe(new URL(baseURL!).origin);
  expect(requests.every((url) => new URL(url).origin === new URL(baseURL!).origin)).toBe(true);
  await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
});

test('unavailable API status is visible and an explicit retry recovers', async ({ page }) => {
  let unavailable = true;

  await page.route('**/api/health/ready', async (route) => {
    if (unavailable) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ status: 'unavailable' }) });
    } else {
      await route.continue();
    }
  });

  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Unavailable');
  await expect(page.getByText('Check the API and DynamoDB containers, then retry.', { exact: false })).toBeVisible();

  unavailable = false;
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('status')).toContainText('API and database resources are ready.');
});

test('an HTML fallback is not mistaken for ready API JSON', async ({ page }) => {
  await page.route('**/api/health/ready', (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: '<html><body>SPA fallback</body></html>',
  }));

  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Unavailable');
});

test('foundation remains usable at a narrow viewport with keyboard-visible controls', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('API and database resources are ready.');

  const button = page.getByRole('button', { name: 'Check again' });

  await button.focus();
  await expect(button).toBeFocused();

  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));

  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  await expect(button).toBeInViewport();
});

test('built browser assets and public health responses contain no model sentinel or server configuration', async ({ page, request }) => {
  const publicBodies: string[] = [];
  page.on('response', (response) => {
    if (/\.(?:js|css)(?:\?|$)/.test(response.url())) {
      publicBodies.push(response.url());
    }
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('API and database resources are ready.');

  const html = await page.content();

  expect(html).not.toContain(sentinel);
  expect(html).not.toContain('LLM_API_KEY');

  for (const url of publicBodies) {
    const response = await request.get(url);
    expect(response.ok()).toBe(true);
    const body = await response.text();

    expect(body).not.toContain(sentinel);
    expect(body).not.toContain('LLM_API_KEY');
    expect(body).not.toContain('AWS_SECRET_ACCESS_KEY');
  }

  expect(publicBodies.some((url) => /\.js(?:\?|$)/.test(url))).toBe(true);

  for (const path of ['/api/health/live', '/api/health/ready']) {
    const response = await request.get(path);
    const body = await response.text();

    expect(body).not.toContain(sentinel);
    expect(body).not.toContain('LLM_API_KEY');
    expect(body).not.toContain('DYNAMODB_ENDPOINT');
  }
});
