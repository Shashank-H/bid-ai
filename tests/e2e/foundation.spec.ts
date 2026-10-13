import { expect, test } from '@playwright/test';

const sentinel = process.env.TEST_SECRET_SENTINEL ?? 'phase0-secret-sentinel-not-for-browser';

test('the production login page and health use only the same-origin proxy', async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Bid Intelligence/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Publisher login' })).toBeVisible();
  const ready = await page.evaluate(async () => {
    const response = await fetch('/api/health/ready');
    return { status: response.status, body: await response.json() };
  });
  expect(ready).toEqual({ status: 200, body: { status: 'ready' } });
  expect(requests.every((url) => new URL(url).origin === new URL(baseURL!).origin)).toBe(true);
});

test('unavailable authentication API is visible and explicit retry recovers', async ({ page }) => {
  let unavailable = true;
  await page.route('**/api/auth/me', async (route) => {
    if (unavailable) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'DEPENDENCY_UNAVAILABLE', message: 'Unavailable' }) });
    else await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'UNAUTHORIZED', message: 'Please log in again.' }) });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('API is unavailable');
  unavailable = false;
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Publisher login' })).toBeVisible();
});

test('an HTML fallback is not mistaken for authenticated API JSON', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>SPA fallback</html>' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('API is unavailable');
});

test('login remains usable at a narrow viewport with keyboard-visible controls', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Log in', exact: true });
  await expect(button).toBeVisible();
  await button.focus();
  await expect(button).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await expect(button).toBeInViewport();
});

test('browser assets and public responses contain no server model sentinel/configuration', async ({ page, request }) => {
  const assets: string[] = [];
  page.on('response', (response) => { if (/\.(?:js|css)(?:\?|$)/.test(response.url())) assets.push(response.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Publisher login' })).toBeVisible();
  expect(await page.content()).not.toContain(sentinel);

  for (const url of assets) {
    const response = await request.get(url);
    expect(response.ok()).toBe(true);
    expect(await response.text()).not.toMatch(new RegExp(`${sentinel}|LLM_API_KEY|AWS_SECRET_ACCESS_KEY|AUTH_SIGNING_SECRET`));
  }
  expect(assets.some((url) => /\.js(?:\?|$)/.test(url))).toBe(true);

  for (const path of ['/api/health/live', '/api/health/ready', '/api/auth/me']) {
    const response = await request.get(path);
    expect(await response.text()).not.toMatch(new RegExp(`${sentinel}|LLM_API_KEY|DYNAMODB_ENDPOINT|AUTH_SIGNING_SECRET`));
  }
});
