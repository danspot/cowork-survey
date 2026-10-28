import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const token = randomUUID();
const questionUrl = `/#/q/${token}`;
const resultUrl = `/#/r/${randomUUID()}`;
const prompt = 'How confident are you about putting Cowork to work?';
const config = { supabaseUrl: 'https://survey-test.supabase.co', publishableKey: 'sb_publishable_abcdefghijklmnop1234' };
const summary = counts => ({
  prompt,
  total: counts.reduce((total, count) => total + count, 0),
  average: counts.some(Boolean) ? counts.reduce((sum, count, index) => sum + count * (index + 1), 0) / counts.reduce((sum, count) => sum + count, 0) : null,
  distribution: counts.map((count, index) => ({ score: index + 1, count })),
  updatedAt: new Date().toISOString(),
});

async function backend(page, overrides = {}) {
  let saved = null;
  const requests = [];
  await page.route('**/config.json', route => route.fulfill({ json: config }));
  await page.route('https://survey-test.supabase.co/rest/v1/rpc/*', async route => {
    const operation = route.request().url().split('/').at(-1);
    const body = route.request().postDataJSON();
    requests.push({ operation, body });
    if (overrides[operation]) return overrides[operation](route, body);
    if (operation === 'cowork_question') return route.fulfill({ json: { prompt, score: saved } });
    if (operation === 'cowork_vote') {
      const recorded = saved === null;
      saved ??= body.p_score;
      return route.fulfill({ json: { score: saved, recorded } });
    }
    return route.fulfill({ json: summary([1, 2, 3, 8, 6]) });
  });
  return requests;
}

for (const width of [320, 375, 390, 768, 1280]) {
  test(`all five choices fit at ${width}px and save a final answer`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    const requests = await backend(page);
    await page.goto(questionUrl);
    await expect(page.getByRole('heading', { name: prompt })).toBeVisible();
    const buttons = page.getByRole('button', { name: /out of 5/ });
    await expect(buttons).toHaveCount(5);
    for (let index = 0; index < 5; index++) {
      const box = await buttons.nth(index).boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(48);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390) {
      await mkdir(resolve(root, '.local'), { recursive: true });
      await page.screenshot({ path: resolve(root, '.local', 'mobile-preview.png'), fullPage: true });
    }
    await page.getByRole('button', { name: '4 out of 5' }).click();
    await expect(page.getByRole('status')).toContainText('You\'re counted. Thank you!');
    await expect(page.getByRole('status')).toContainText('4 out of 5');
    await expect(buttons.nth(3)).toHaveAttribute('aria-pressed', 'true');
    for (const button of await buttons.all()) await expect(button).toBeDisabled();
    expect(requests.filter(request => request.operation === 'cowork_vote')).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole('status')).toContainText('You\'re already counted.');
    await expect(page.getByRole('status')).toContainText('4 out of 5');
  });
}

test('keyboard users can answer without a pointer', async ({ page }) => {
  await backend(page);
  await page.goto(questionUrl);
  await expect(page.getByRole('button', { name: '1 out of 5' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '1 out of 5' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('1 out of 5');
});

test('a lost confirmation retries safely and shows the original answer', async ({ page }) => {
  let first = true;
  await backend(page, {
    cowork_vote: route => {
      if (first) {
        first = false;
        return route.abort('failed');
      }
      return route.fulfill({ json: { score: 2, recorded: false } });
    },
  });
  await page.goto(questionUrl);
  await page.getByRole('button', { name: '2 out of 5' }).click();
  await expect(page.getByRole('status')).toContainText('couldn\'t confirm');
  await page.getByRole('button', { name: '5 out of 5' }).click();
  await expect(page.getByRole('status')).toContainText('2 out of 5');
  await expect(page.getByRole('button', { name: '2 out of 5' })).toHaveAttribute('aria-pressed', 'true');
});

test('null vote responses do not report success', async ({ page }) => {
  await backend(page, { cowork_vote: route => route.fulfill({ body: 'null', contentType: 'application/json' }) });
  await page.goto(questionUrl);
  await page.getByRole('button', { name: '3 out of 5' }).click();
  await expect(page.getByRole('status')).toContainText('couldn\'t confirm');
  await expect(page.getByRole('button', { name: '3 out of 5' })).toBeEnabled();
});

test('unknown links and unconfigured storage are explicit', async ({ page }) => {
  await page.goto('/#/q/not-a-guid');
  await expect(page.getByRole('heading')).toHaveText('This link isn\'t valid.');
  await page.route('**/config.json', route => route.fulfill({ json: { supabaseUrl: '', publishableKey: '' } }));
  await page.goto(questionUrl);
  await expect(page.getByRole('heading')).toHaveText('This survey isn\'t live yet.');
  await expect(page.getByRole('button', { name: /out of 5/ })).toHaveCount(0);
});

test('missing browser storage is not silently replaced with a fresh identity', async ({ page }) => {
  await backend(page);
  await page.addInitScript(() => { Storage.prototype.getItem = () => { throw new Error('Storage blocked'); }; });
  await page.goto(questionUrl);
  await expect(page.getByRole('heading')).toHaveText('Browser storage is needed.');
});

test('question text is rendered as text, not executable markup', async ({ page }) => {
  const unsafe = '<img src=x onerror="alert(1)"> What\'s your take?';
  await backend(page, { cowork_question: route => route.fulfill({ json: { prompt: unsafe, score: null } }) });
  await page.goto(questionUrl);
  await expect(page.getByRole('heading')).toHaveText(unsafe);
  await expect(page.locator('h1 img')).toHaveCount(0);
});

test('live results calculate counts, percentages, and mean, retaining confirmed data on failure', async ({ page }) => {
  let calls = 0;
  await backend(page, {
    cowork_results: route => {
      calls++;
      return calls === 1 ? route.fulfill({ json: summary([1, 2, 3, 8, 6]) }) : route.fulfill({ status: 503, body: 'Unavailable' });
    },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(resultUrl);
  await expect(page.locator('.metric-value').first()).toHaveText('20');
  await expect(page.locator('.metric-value').last()).toHaveText('3.8');
  await expect(page.locator('.bar-percent')).toHaveText(['5%', '10%', '15%', '40%', '30%']);
  await expect(page.locator('.bar-4')).toHaveJSProperty('offsetWidth', await page.locator('.bar-4').evaluate(bar => Math.round(bar.parentElement.clientWidth * .4)));
  await mkdir(resolve(root, '.local'), { recursive: true });
  await page.screenshot({ path: resolve(root, '.local', 'results-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Refresh now' }).click();
  await expect(page.getByRole('status')).toContainText('Showing last confirmed results');
  await expect(page.locator('.metric-value').first()).toHaveText('20');
});

test('no responses show zero buckets and no invented mean', async ({ page }) => {
  await backend(page, { cowork_results: route => route.fulfill({ json: summary([0, 0, 0, 0, 0]) }) });
  await page.goto(resultUrl);
  await expect(page.locator('.metric-value').first()).toHaveText('0');
  await expect(page.locator('.metric-value').last()).toHaveText('--');
  await expect(page.locator('.bar-percent')).toHaveText(['0%', '0%', '0%', '0%', '0%']);
});

test('each branded QR decodes from the actual offline HTML on desktop and mobile', async ({ page }) => {
  const manifest = JSON.parse(await readFile(resolve(root, '.local', 'survey.json'), 'utf8'));
  await page.goto(pathToFileURL(resolve(root, '..', 'cowork-survey-qr.html')).href);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const codes = page.locator('.qr');
    await expect(codes).toHaveCount(manifest.questions.length);
    for (let index = 0; index < manifest.questions.length; index++) {
      const image = PNG.sync.read(await codes.nth(index).screenshot());
      const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
      expect(decoded?.data).toBe(`${manifest.siteUrl}/#/q/${manifest.questions[index].questionToken}`);
      const results = page.locator('.results-link').nth(index);
      await expect(results).toHaveAttribute('href', `${manifest.siteUrl}/#/r/${manifest.questions[index].resultsToken}`);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.links').first()).toBeHidden();
  await expect(page.locator('details').first()).toBeHidden();
});
