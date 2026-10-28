import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { buildSheet, readQuestions, reconcileQuestions, seedSql } from '../../tools/prepare.mjs';

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
const multipleQuestion = {
  prompt: 'Which tools would you use?',
  kind: 'multiple_choice',
  options: ['Cowork', 'Agents', "I don't know", 'Other', 'Both', 'Neither', '<img src=x onerror=alert(1)>'],
  score: null, selections: [], editable: true,
};
const multipleSummary = (counts = [2, 1, 1, 0, 0, 0, 1], total = 2) => ({
  prompt: multipleQuestion.prompt, kind: 'multiple_choice', options: multipleQuestion.options,
  total, average: null,
  distribution: multipleQuestion.options.map((option, index) => ({ option, count: counts[index] })),
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
    if (operation === 'cowork_question') return route.fulfill({ json: { prompt, score: saved, editable: true } });
    if (operation === 'cowork_vote') {
      saved = body.p_score;
      return route.fulfill({ json: { score: saved, recorded: true } });
    }
    return route.fulfill({ json: summary([1, 2, 3, 8, 6]) });
  });
  return requests;
}

async function localBackend(page, override) {
  const manifest = JSON.parse(await readFile(resolve(root, '.local', 'survey.json'), 'utf8'));
  const requests = [];
  await page.route('https://*.supabase.co/rest/v1/rpc/cowork_results', route => {
    const body = route.request().postDataJSON();
    const index = manifest.questions.findIndex(question => question.resultsToken === body.p_results_token);
    expect(index).toBeGreaterThanOrEqual(0);
    requests.push({ index, body, origin: route.request().headers().origin });
    if (override) return override(route, index);
    const question = manifest.questions[index];
    return route.fulfill({ json: question.kind === 'multiple_choice' ? {
      prompt: question.prompt, kind: question.kind, options: question.options,
      total: 0, average: null, distribution: question.options.map(option => ({ option, count: 0 })),
      updatedAt: new Date().toISOString(),
    } : { ...summary(index === 0 ? [1, 2, 3, 8, 6] : [0, 0, 0, 0, 0]), prompt: question.prompt } });
  });
  return { manifest, requests };
}

async function multipleBackend(page, overrides = {}) {
  let saved = [];
  return backend(page, {
    cowork_question: route => route.fulfill({ json: { ...multipleQuestion, selections: saved } }),
    cowork_choose: (route, body) => {
      saved = body.p_selections;
      return route.fulfill({ json: { kind: 'multiple_choice', selections: saved, recorded: true } });
    },
    cowork_results: route => route.fulfill({ json: multipleSummary() }),
    ...overrides,
  });
}

for (const width of [320, 390, 1280]) {
  test(`multi-select questions fit at ${width}px and save editable selections`, async ({ page }) => {
    const requests = await multipleBackend(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(questionUrl);
    await expect(page.getByRole('heading')).toHaveText(multipleQuestion.prompt);
    await expect(page.getByRole('checkbox')).toHaveCount(7);
    await expect(page.locator('.score-button, .option-label img')).toHaveCount(0);
    const save = page.getByRole('button', { name: 'Save answer' });
    await expect(save).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Cowork', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Agents', exact: true }).check();
    expect(requests.filter(request => request.operation === 'cowork_choose')).toHaveLength(0);
    await save.click();
    await expect(page.getByRole('status')).toContainText('You\'re counted. Thank you!');
    expect(requests.filter(request => request.operation === 'cowork_choose').at(-1).body.p_selections).toEqual(['Cowork', 'Agents']);
    await expect(save).toBeDisabled();
    await page.reload();
    await expect(page.getByRole('status')).toContainText('Your response is saved.');
    await expect(page.getByRole('checkbox', { name: 'Cowork', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Agents', exact: true })).toBeChecked();
    await page.getByRole('checkbox', { name: 'Cowork', exact: true }).uncheck();
    await save.click();
    await expect(page.getByRole('status')).toContainText('Answer updated.');
    expect(requests.filter(request => request.operation === 'cowork_choose').at(-1).body.p_selections).toEqual(['Agents']);
    await page.getByRole('checkbox', { name: 'Agents', exact: true }).uncheck();
    await expect(save).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390) await page.screenshot({ path: resolve(root, '.local', 'multiple-choice-preview.png'), fullPage: true });
  });
}

test('multi-select saves block duplicate submissions, animate, and support keyboard input', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await multipleBackend(page, {
    cowork_choose: async (route, body) => {
      await pending;
      return route.fulfill({ json: { kind: 'multiple_choice', recorded: true, selections: body.p_selections } });
    },
  });
  await page.goto(questionUrl);
  const first = page.getByRole('checkbox').first();
  await first.focus();
  await page.keyboard.press('Space');
  await expect(first).toBeChecked();
  const save = page.getByRole('button', { name: 'Save answer' });
  try {
    expect(await save.evaluate(item => {
      item.click();
      return item.getAnimations().some(animation => animation.playState === 'running');
    })).toBe(true);
    await expect(save).toBeDisabled();
    await expect(first).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole('status')).toContainText('You\'re counted.');
  await expect(first).toBeEnabled();
});

test('returning a multi-select draft to its confirmed answer does not claim unsaved changes', async ({ page }) => {
  await multipleBackend(page);
  await page.goto(questionUrl);
  const first = page.getByRole('checkbox').first();
  await first.check();
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.getByRole('status')).toContainText('You\'re counted.');
  await first.uncheck();
  await expect(page.getByRole('status')).toHaveText('Select at least one option.');
  await first.check();
  await expect(page.getByRole('status')).toContainText('Your response is saved.');
  await expect(page.getByRole('button', { name: 'Save answer' })).toBeDisabled();
});

test('multi-select failed saves retain the draft and can be retried without false confirmation', async ({ page }) => {
  let attempts = 0;
  await multipleBackend(page, {
    cowork_choose: (route, body) => {
      attempts++;
      if (attempts === 1) return route.abort('failed');
      if (attempts === 2) return route.fulfill({ json: { kind: 'multiple_choice', recorded: true, selections: ['Other'] } });
      return route.fulfill({ json: { kind: 'multiple_choice', recorded: true, selections: body.p_selections } });
    },
  });
  await page.goto(questionUrl);
  await page.getByRole('checkbox', { name: 'Cowork', exact: true }).check();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page.getByRole('status')).toContainText('couldn\'t confirm');
    await expect(page.getByRole('checkbox', { name: 'Cowork', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Other', exact: true })).not.toBeChecked();
  }
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.getByRole('status')).toContainText('You\'re counted.');
});

test('multi-select reporting uses respondent percentages, not a rating mean, and retains confirmed data on failure', async ({ page }) => {
  let calls = 0;
  await multipleBackend(page, {
    cowork_results: route => route.fulfill({ json: multipleSummary(++calls === 1 ? undefined : [3, 0, 0, 0, 0, 0, 0]) }),
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(resultUrl);
  await expect(page.locator('.metric-value')).toHaveText(['2', '5']);
  await expect(page.locator('.metric-label')).toHaveText(['RESPONSES', 'SELECTIONS']);
  await expect(page.locator('.bar-percent')).toHaveText(['100%', '50%', '50%', '0%', '0%', '0%', '50%']);
  await expect(page.locator('.chart-label')).toHaveText(multipleQuestion.options);
  await expect(page.locator('.chart-label img')).toHaveCount(0);
  await expect(page.locator('.selection-note')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Refresh now' }).click();
  await expect(page.getByRole('status')).toContainText('Showing last confirmed results');
  await expect(page.locator('.metric-value')).toHaveText(['2', '5']);
});

test('empty multi-select results have zero counts and no invented mean', async ({ page }) => {
  await multipleBackend(page, { cowork_results: route => route.fulfill({ json: multipleSummary([0, 0, 0, 0, 0, 0, 0], 0) }) });
  await page.goto(resultUrl);
  await expect(page.locator('.metric-value')).toHaveText(['0', '0']);
  await expect(page.locator('.metric-label').last()).toHaveText('SELECTIONS');
  await expect(page.locator('.bar-percent')).toHaveText(Array(7).fill('0%'));
});

test('the generated local page renders mixed question types, safely labels options, and refreshes inline', async ({ page }) => {
  const manifest = { siteUrl: 'https://test.github.io/survey', questions: reconcileQuestions(readQuestions(
    `Rate it\n${multipleQuestion.prompt} | ${multipleQuestion.options.join(' | ')}`,
  )) };
  const file = resolve(root, '.local', 'mixed-test-control.html');
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(file, await buildSheet(manifest, '', '', config));
  let calls = 0;
  await page.route('https://survey-test.supabase.co/rest/v1/rpc/cowork_results', route => {
    const multiple = route.request().postDataJSON().p_results_token === manifest.questions[1].resultsToken;
    if (multiple && ++calls === 2) return route.abort('failed');
    return route.fulfill({ json: multiple ? multipleSummary() : summary([0, 0, 0, 0, 0]) });
  });
  try {
    await page.goto(pathToFileURL(file).href);
    const rating = page.locator('.card').first();
    const multiple = page.locator('.card').last();
    await expect(rating.locator('.result-secondary')).toHaveText('--');
    await expect(rating.locator('.result-secondary-label')).toHaveText('avg / 5');
    await expect(multiple.locator('.result-total')).toHaveText('2');
    await expect(multiple.locator('.result-secondary')).toHaveText('5');
    await expect(multiple.locator('.result-secondary-label')).toHaveText('selections');
    await expect(multiple.locator('.result-score')).toHaveText(multipleQuestion.options);
    await expect(multiple.locator('.result-score img')).toHaveCount(0);
    await expect(multiple.locator('.result-percent')).toHaveText(['100%', '50%', '50%', '0%', '0%', '0%', '50%']);
    await multiple.locator('.refresh-button').click();
    await expect(multiple.locator('.result-status')).toContainText('showing last confirmed results');
    await expect(multiple.locator('.result-total')).toHaveText('2');
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(page.context().pages()).toHaveLength(1);
  } finally {
    await rm(file, { force: true });
  }
});
for (const width of [320, 375, 390, 768, 1280]) {
  test(`all five choices fit at ${width}px and allow answer changes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    const requests = await backend(page);
    await page.goto(questionUrl);
    await expect(page.getByRole('heading', { name: prompt })).toBeVisible();
    await expect(page.locator('.brand')).toHaveText('PPCC 2026 | COWORK ATE MY AGENTS');
    await expect(page.locator('.eyebrow, .description, .fine-print, footer')).toHaveCount(0);
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
    for (const button of await buttons.all()) await expect(button).toBeEnabled();
    expect(requests.filter(request => request.operation === 'cowork_vote')).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole('status')).toContainText('Your response is saved.');
    await expect(page.getByRole('status')).toContainText('4 out of 5');
    await page.getByRole('button', { name: '2 out of 5' }).click();
    await expect(page.getByRole('status')).toContainText('Answer updated.');
    await expect(page.getByRole('status')).toContainText('2 out of 5');
    await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(buttons.nth(3)).toHaveAttribute('aria-pressed', 'false');
    expect(requests.filter(request => request.operation === 'cowork_vote')).toHaveLength(2);
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

test('mixed voting and both reports work end to end against the actual PostgreSQL RPCs', async ({ page }) => {
  test.slow();
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  const file = resolve(root, '.local', 'mixed-db-control.html');
  try {
    await db.exec('create role anon; create role authenticated;');
    await db.exec(await readFile(resolve(root, 'supabase', 'schema.sql'), 'utf8'));
    const questions = reconcileQuestions(readQuestions('Rate it\nWhich tools? | Cowork | Agents | Both'));
    await db.exec(seedSql(questions));
    await db.exec('set role anon');
    await page.route('**/config.json', route => route.fulfill({ json: config }));
    await page.route('https://survey-test.supabase.co/rest/v1/rpc/*', async route => {
      const operation = route.request().url().split('/').at(-1);
      expect(['cowork_question', 'cowork_vote', 'cowork_choose', 'cowork_results']).toContain(operation);
      const body = route.request().postDataJSON();
      const keys = operation === 'cowork_results' ? ['p_results_token']
        : operation === 'cowork_question' ? ['p_question_token', 'p_browser_token']
          : ['p_question_token', 'p_browser_token', operation === 'cowork_vote' ? 'p_score' : 'p_selections'];
      const placeholders = keys.map((_, index) => `$${index + 1}`).join(',');
      const { rows } = await db.query(`select public.${operation}(${placeholders}) as value`, keys.map(key => body[key]));
      return route.fulfill({ json: rows[0].value });
    });
    await page.goto(`/#/q/${questions[0].questionToken}`);
    await page.getByRole('button', { name: '4 out of 5' }).click();
    await expect(page.getByRole('status')).toContainText('You\'re counted.');
    await page.goto(`/#/q/${questions[1].questionToken}`);
    await page.getByRole('checkbox', { name: 'Cowork', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Agents', exact: true }).check();
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page.getByRole('status')).toContainText('You\'re counted.');
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'Cowork', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Agents', exact: true })).toBeChecked();
    await page.getByRole('checkbox', { name: 'Cowork', exact: true }).uncheck();
    await page.getByRole('button', { name: 'Save answer' }).click();
    await expect(page.getByRole('status')).toContainText('Answer updated.');
    await page.goto(`/#/r/${questions[1].resultsToken}`);
    await expect(page.locator('.metric-value')).toHaveText(['1', '1']);
    await expect(page.locator('.bar-percent')).toHaveText(['0%', '100%', '0%']);
    const manifest = { siteUrl: 'https://test.github.io/survey', questions };
    await mkdir(resolve(root, '.local'), { recursive: true });
    await writeFile(file, await buildSheet(manifest, '', '', config));
    await page.goto(pathToFileURL(file).href);
    const rating = page.locator('.card').first();
    const multiple = page.locator('.card').last();
    await expect(rating.locator('.result-total')).toHaveText('1');
    await expect(rating.locator('.result-secondary')).toHaveText('4.0');
    await expect(multiple.locator('.result-total')).toHaveText('1');
    await expect(multiple.locator('.result-secondary')).toHaveText('1');
    await expect(multiple.locator('.result-percent')).toHaveText(['0%', '100%', '0%']);
    await db.exec('reset role');
    await db.exec(seedSql([questions[0], { ...questions[1], kind: 'rating', options: [] }]));
    await db.exec('set role anon');
    await multiple.locator('.refresh-button').click();
    await expect(multiple.locator('.result-total')).toHaveText('0');
    await expect(multiple.locator('.result-secondary-label')).toHaveText('avg / 5');
    await expect(multiple.locator('.result-count')).toHaveText(['0', '0', '0', '0', '0']);
    await expect(rating.locator('.result-total')).toHaveText('1');
  } finally {
    await db.close();
    await rm(file, { force: true });
  }
});

test('a lost confirmation can be retried with a changed answer', async ({ page }) => {
  let first = true;
  await backend(page, {
    cowork_vote: (route, body) => {
      if (first) {
        first = false;
        return route.abort('failed');
      }
      return route.fulfill({ json: { score: body.p_score, recorded: true } });
    },
  });
  await page.goto(questionUrl);
  await page.getByRole('button', { name: '2 out of 5' }).click();
  await expect(page.getByRole('status')).toContainText('couldn\'t confirm');
  await page.getByRole('button', { name: '5 out of 5' }).click();
  await expect(page.getByRole('status')).toContainText('5 out of 5');
  await expect(page.getByRole('button', { name: '5 out of 5' })).toHaveAttribute('aria-pressed', 'true');
});

test('the clicked number animates on successive answers while saving', async ({ page }) => {
  await backend(page, {
    cowork_vote: async (route, body) => {
      await new Promise(resolve => setTimeout(resolve, 700));
      return route.fulfill({ json: { score: body.p_score, recorded: true } });
    },
  });
  await page.goto(questionUrl);
  for (const score of [3, 5]) {
    const button = page.getByRole('button', { name: `${score} out of 5` });
    await button.click();
    expect(await button.evaluate(item => item.getAnimations().some(animation => animation.playState === 'running'))).toBe(true);
    for (const choice of await page.getByRole('button', { name: /out of 5/ }).all()) await expect(choice).toBeDisabled();
    await expect(page.getByRole('status')).toContainText(`${score} out of 5`);
    await expect(button).toBeEnabled();
  }
});

test('button animation respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await backend(page);
  await page.goto(questionUrl);
  const button = page.getByRole('button', { name: '3 out of 5' });
  await button.click();
  await expect(page.getByRole('status')).toContainText('3 out of 5');
  expect(await button.evaluate(item => item.getAnimations().length)).toBe(0);
});

test('the UI waits for the editable-answer database update', async ({ page }) => {
  await backend(page, { cowork_question: route => route.fulfill({ json: { prompt, score: 3 } }) });
  await page.goto(questionUrl);
  await expect(page.getByRole('heading')).toHaveText('This survey is being updated.');
  await expect(page.getByRole('button', { name: /out of 5/ })).toHaveCount(0);
});

test('a server-confirmed different score does not falsely confirm the new choice', async ({ page }) => {
  await backend(page, { cowork_vote: route => route.fulfill({ json: { score: 2, recorded: true } }) });
  await page.goto(questionUrl);
  await page.getByRole('button', { name: '5 out of 5' }).click();
  await expect(page.getByRole('status')).toContainText('couldn\'t confirm');
  await expect(page.getByRole('button', { name: '5 out of 5' })).toHaveAttribute('aria-pressed', 'false');
});

test('a failed change keeps the confirmed selection and can be retried', async ({ page }) => {
  let first = true;
  await backend(page, {
    cowork_question: route => route.fulfill({ json: { prompt, score: 2, editable: true } }),
    cowork_vote: (route, body) => {
      if (first) {
        first = false;
        return route.fulfill({ status: 503, body: 'Unavailable' });
      }
      return route.fulfill({ json: { score: body.p_score, recorded: true } });
    },
  });
  await page.goto(questionUrl);
  await page.getByRole('button', { name: '5 out of 5' }).click();
  await expect(page.getByRole('status')).toContainText('couldn\'t confirm');
  await expect(page.getByRole('button', { name: '2 out of 5' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '5 out of 5' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '4 out of 5' }).click();
  await expect(page.getByRole('status')).toContainText('Answer updated.');
  await expect(page.getByRole('status')).toContainText('4 out of 5');
  await expect(page.getByRole('status')).not.toHaveClass(/has-error/);
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
  await backend(page, { cowork_question: route => route.fulfill({ json: { prompt: unsafe, score: null, editable: true } }) });
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
  const { manifest } = await localBackend(page);
  await page.goto(pathToFileURL(resolve(root, '..', 'cowork-survey-qr.html')).href);
  for (const [width, height] of [[1280, 720], [800, 600], [375, 900]]) {
    await page.setViewportSize({ width, height });
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
  await expect(page.locator('.results').first()).toBeHidden();
  await expect(page.locator('.actions').first()).toBeHidden();
  await expect(page.locator('header')).toBeHidden();
  await expect(page.locator('.copy-button').first()).toBeHidden();
  await expect(page.locator('.copy-status').first()).toBeHidden();
});

test('the local QR sheet fits all cards and controls on one laptop screen', async ({ page }) => {
  await localBackend(page);
  await page.goto(pathToFileURL(resolve(root, '..', 'cowork-survey-qr.html')).href);
  for (const status of await page.locator('.result-status').all()) await expect(status).toContainText('Updated');
  await expect(page.locator('.hero, .notice, .tag, .scan-label, details, footer')).toHaveCount(0);
  await expect(page.locator('header')).toHaveText('PPCC 2026 | COWORK ATE MY AGENTS Print QRs');
  for (const [width, height] of [[800, 600], [1024, 600], [1280, 720], [1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    expect(dimensions.width, `${width}x${height} horizontal fit`).toBeLessThanOrEqual(width);
    expect(dimensions.height, `${width}x${height} vertical fit`).toBeLessThanOrEqual(height);
    for (const card of await page.locator('.card').all()) {
      await expect(card).toBeInViewport({ ratio: 1 });
      await expect(card.locator('.copy-button')).toBeInViewport({ ratio: 1 });
      await expect(card.locator('.refresh-button')).toBeInViewport({ ratio: 1 });
      await expect(card.locator('.question-link')).toBeInViewport({ ratio: 1 });
      await expect(card.locator('.results-link')).toBeInViewport({ ratio: 1 });
      await expect(card.locator('.results')).toBeInViewport({ ratio: 1 });
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: resolve(root, '.local', 'qr-sheet-preview.png'), fullPage: true });
});

test('each local QR copies a decodable PNG with its center mascot while offline', async ({ page }) => {
  const manifest = JSON.parse(await readFile(resolve(root, '.local', 'survey.json'), 'utf8'));
  await page.context().setOffline(true);
  await page.addInitScript(() => {
    window.copiedImages = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        write: async items => {
          const blob = await items[0].getType('image/png');
          window.copiedImages.push(Array.from(new Uint8Array(await blob.arrayBuffer())));
        },
      },
    });
  });
  await page.goto(pathToFileURL(resolve(root, '..', 'cowork-survey-qr.html')).href);
  await expect(page.locator('.copy-button')).toHaveCount(manifest.questions.length);
  for (let index = 0; index < manifest.questions.length; index++) {
    const card = page.locator('.card').nth(index);
    await card.getByRole('button', { name: `Copy QR image for question ${index + 1}` }).click();
    await expect(card.locator('.copy-status')).toHaveText('QR image copied.');
    const image = PNG.sync.read(Buffer.from(await page.evaluate(() => window.copiedImages.at(-1))));
    expect(image.width).toBe(await card.locator('.qr svg').evaluate(svg => svg.viewBox.baseVal.width * 16));
    expect(image.height).toBe(image.width);
    const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
    expect(decoded?.data).toBe(`${manifest.siteUrl}/#/q/${manifest.questions[index].questionToken}`);
    expect([...image.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    let mascotPixels = 0;
    for (let y = Math.floor(image.height * .4); y < image.height * .6; y++) {
      for (let x = Math.floor(image.width * .4); x < image.width * .6; x++) {
        const offset = (y * image.width + x) * 4;
        const [red, green, blue] = image.data.subarray(offset, offset + 3);
        if (red > 50 && blue > 100 && blue > green * 1.15) mascotPixels++;
      }
    }
    expect(mascotPixels).toBeGreaterThan(100);
    await expect(card.locator('.copy-button')).toBeEnabled();
  }
});

for (const failure of ['unavailable', 'denied']) {
  test(`QR copy reports ${failure} clipboard access without claiming success`, async ({ page }) => {
    await localBackend(page);
    await page.addInitScript(failure => {
      Object.defineProperty(navigator, 'clipboard', {
        value: failure === 'unavailable' ? undefined : {
          write: async items => {
            await items[0].getType('image/png');
            throw new DOMException('Clipboard access denied', 'NotAllowedError');
          },
        },
      });
    }, failure);
    await page.goto(pathToFileURL(resolve(root, '..', 'cowork-survey-qr.html')).href);
    const card = page.locator('.card').first();
    await card.locator('.copy-button').click();
    await expect(card.locator('.copy-status')).toContainText('Could not copy.');
    await expect(card.locator('.copy-status')).not.toContainText('QR image copied.');
    await expect(card.locator('.copy-button')).toBeEnabled();
  });
}

test('local results load inline and each refresh is independent without opening tabs', async ({ page }) => {
  let releaseRefresh;
  const pending = new Promise(resolve => { releaseRefresh = resolve; });
  let firstCalls = 0;
  const { requests } = await localBackend(page, async (route, index) => {
    if (index === 0) {
      firstCalls++;
      if (firstCalls === 2) {
        await pending;
        return route.fulfill({ json: summary([0, 0, 1, 1, 8]) });
      }
      return route.fulfill({ json: summary([1, 2, 3, 8, 6]) });
    }
    return route.fulfill({ json: summary([0, 0, 0, 0, 0]) });
  });
  const url = pathToFileURL(resolve(root, '..', 'cowork-survey-qr.html')).href;
  await page.goto(url);
  const first = page.locator('.card').nth(0);
  const second = page.locator('.card').nth(1);
  await expect(first.locator('.result-total')).toHaveText('20');
  await expect(first.locator('.result-secondary')).toHaveText('3.8');
  await expect(first.locator('.result-percent')).toHaveText(['5%', '10%', '15%', '40%', '30%']);
  await expect(second.locator('.result-total')).toHaveText('0');
  await expect(second.locator('.result-secondary')).toHaveText('--');
  await expect(second.locator('.result-count')).toHaveText(['0', '0', '0', '0', '0']);
  try {
    await first.locator('.refresh-button').click();
    await expect(first.locator('.refresh-button')).toBeDisabled();
    await expect(second.locator('.refresh-button')).toBeEnabled();
    await second.locator('.refresh-button').click();
    await expect(second.locator('.refresh-button')).toBeEnabled();
    expect(requests.filter(request => request.index === 1)).toHaveLength(2);
  } finally {
    releaseRefresh();
  }
  await expect(first.locator('.result-total')).toHaveText('10');
  await expect(first.locator('.result-secondary')).toHaveText('4.7');
  await expect(first.locator('.result-percent')).toHaveText(['0%', '0%', '10%', '10%', '80%']);
  await expect(first.locator('.refresh-button')).toBeEnabled();
  await expect(first.locator('.result-status')).toContainText('Updated');
  expect(requests.filter(request => request.index === 0)).toHaveLength(2);
  expect(requests.filter(request => request.index === 2)).toHaveLength(1);
  expect(requests.every(request => request.origin === 'null')).toBe(true);
  expect(page.url()).toBe(url);
  expect(page.context().pages()).toHaveLength(1);
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('local results retain confirmed data on network and invalid-response failures', async ({ page }) => {
  let calls = 0;
  await localBackend(page, (route, index) => {
    if (index !== 0) return route.fulfill({ json: summary([0, 0, 0, 0, 0]) });
    calls++;
    if (calls === 2) return route.fulfill({ status: 503, body: 'Unavailable' });
    if (calls === 3) return route.fulfill({ json: { ...summary([1, 2, 3, 8, 6]), total: 99 } });
    return route.fulfill({ json: summary(calls === 1 ? [1, 2, 3, 8, 6] : [0, 0, 0, 0, 0]) });
  });
  await page.goto(pathToFileURL(resolve(root, '..', 'cowork-survey-qr.html')).href);
  const card = page.locator('.card').first();
  await expect(card.locator('.result-total')).toHaveText('20');
  for (let attempt = 0; attempt < 2; attempt++) {
    await card.locator('.refresh-button').click();
    await expect(card.locator('.result-status')).toContainText('showing last confirmed results');
    await expect(card.locator('.result-total')).toHaveText('20');
    await expect(card.locator('.result-secondary')).toHaveText('3.8');
    await expect(card.locator('.result-percent')).toHaveText(['5%', '10%', '15%', '40%', '30%']);
  }
  await card.locator('.refresh-button').click();
  await expect(card.locator('.result-total')).toHaveText('0');
  await expect(card.locator('.result-secondary')).toHaveText('--');
  await expect(card.locator('.result-status')).not.toHaveClass(/has-error/);
});

test('an unavailable initial result does not invent zero responses and can be retried', async ({ page }) => {
  let first = true;
  await localBackend(page, (route, index) => {
    if (index === 0 && first) {
      first = false;
      return route.abort('failed');
    }
    return route.fulfill({ json: summary([0, 0, 0, 0, 0]) });
  });
  await page.goto(pathToFileURL(resolve(root, '..', 'cowork-survey-qr.html')).href);
  const card = page.locator('.card').first();
  await expect(card.locator('.result-status')).toHaveText('Results unavailable. Refresh to retry.');
  await expect(card.locator('.result-total')).toHaveText('--');
  await expect(card.locator('.result-count')).toHaveText(['--', '--', '--', '--', '--']);
  await card.locator('.refresh-button').click();
  await expect(card.locator('.result-status')).toContainText('Updated');
  await expect(card.locator('.result-total')).toHaveText('0');
});
