import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DIGITS, COLORS, parseRoute, digitSvg, validateConfig, validateResults, validateVote } from '../web/shared.js';
import { escapeHtml, readQuestions, reconcileQuestions, seedSql } from '../tools/prepare.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('poll tokens match the original five colors and seven-row dotted glyphs', () => {
  assert.deepEqual(COLORS, ['#6ec3ff', '#86eabe', '#c1acff', '#99b7ff', '#f3a3dc']);
  for (let score = 1; score <= 5; score++) {
    const digit = DIGITS[score - 1];
    assert.equal(digit.split('/').length, 7);
    assert.equal([...digit].filter(bit => bit === '1').length, (digitSvg(score).match(/ r="2.35"/g) ?? []).length);
  }
  assert.throws(() => digitSvg(0));
});

test('routes require an independent UUID, not a discoverable number or path', () => {
  const token = randomUUID();
  assert.deepEqual(parseRoute(`#/q/${token}`), { view: 'q', token });
  assert.deepEqual(parseRoute(`#/r/${token.toUpperCase()}`), { view: 'r', token });
  for (const hash of ['', '#/q/1', `#/x/${token}`, `#/q/${token}/more`, '#/q/<script>']) {
    assert.equal(parseRoute(hash), null);
  }
});

test('browser configuration rejects admin keys and non-Supabase origins', () => {
  const key = 'sb_publishable_abcdefghijklmnop1234';
  assert.equal(validateConfig({ supabaseUrl: '', publishableKey: '' }), false);
  assert.equal(validateConfig({ supabaseUrl: 'https://test.supabase.co', publishableKey: key }), true);
  const legacy = role => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
  assert.equal(validateConfig({ supabaseUrl: 'https://test.supabase.co', publishableKey: legacy('anon') }), true);
  assert.throws(() => validateConfig({ supabaseUrl: 'https://test.supabase.co', publishableKey: legacy('service_role') }));
  assert.throws(() => validateConfig({ supabaseUrl: 'https://test.supabase.co', publishableKey: 'sb_secret_nope' }));
  for (const supabaseUrl of ['http://test.supabase.co', 'https://evil.example', 'https://test.supabase.co.evil.example', 'https://test.supabase.co/path', 'https://user:test@test.supabase.co']) {
    assert.throws(() => validateConfig({ supabaseUrl, publishableKey: key }));
  }
});

test('question imports handle BOMs, CRLFs, blanks, apostrophes, and stable URL regeneration', () => {
  const prompts = readQuestions('\uFEFFHow was it?\r\n\r\n What\'s next? \r\n');
  assert.deepEqual(prompts, ['How was it?', 'What\'s next?']);
  const first = reconcileQuestions(prompts);
  const second = reconcileQuestions(['Revised question', 'What\'s next?', 'New question'], first);
  assert.equal(second[0].questionToken, first[0].questionToken);
  assert.equal(second[0].resultsToken, first[0].resultsToken);
  assert.notEqual(first[0].questionToken, first[0].resultsToken);
  const sql = seedSql(second);
  assert.ok(sql.includes("What''s next?"));
  assert.ok(sql.includes('set enabled = false'));
  assert.ok(!sql.includes(first[0].resultsToken));
  assert.throws(() => readQuestions('\n\n'));
  assert.throws(() => readQuestions('x'.repeat(2001)));
  assert.equal(escapeHtml('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
});

test('responses require explicit, valid confirmation and consistent result counts', () => {
  assert.throws(() => validateVote(null));
  assert.throws(() => validateVote({ score: 3 }));
  assert.deepEqual(validateVote({ score: 3, recorded: false }), { score: 3, recorded: false });
  const data = {
    prompt: 'A question', total: 0, average: null,
    distribution: [1, 2, 3, 4, 5].map(score => ({ score, count: 0 })),
    updatedAt: '2026-10-28T19:00:00+00:00',
  };
  assert.equal(validateResults(data), data);
  assert.throws(() => validateResults({ ...data, total: 2 }));
  assert.throws(() => validateResults({ ...data, updatedAt: '2026-10-28T19:00:00' }));
});

test('private question inventory and results tokens are absent from every deployed file', async context => {
  const manifestPath = resolve(root, '.local', 'survey.json');
  if (!existsSync(manifestPath)) return context.skip('Private production inventory is local-only.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const privateValues = manifest.questions.flatMap(item => [item.questionToken, item.resultsToken, item.prompt]);
  const entries = await readdir(resolve(root, 'web'), { withFileTypes: true, recursive: true });
  for (const item of entries.filter(item => item.isFile())) {
    const content = await readFile(resolve(item.parentPath, item.name));
    for (const value of privateValues) assert.ok(!content.includes(Buffer.from(value)), `${item.name} leaked private data`);
  }
  const workflow = await readFile(resolve(root, '.github', 'workflows', 'pages.yml'), 'utf8');
  assert.match(workflow, /path: web/);
});
