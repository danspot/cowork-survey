import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { COLORS, UUID, isQuestionDefinition, validateConfig, validateResults } from '../web/shared.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const escapeHtml = text => String(text).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const sqlText = text => `'${text.replaceAll("'", "''")}'`;

export function readQuestions(text) {
  const questions = [];
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes('\0') || [...line].length > 2000) {
      throw new Error(`Line ${index + 1}: use at most 2,000 characters, without null bytes.`);
    }
    const [prompt, ...options] = line.split('|').map(value => value.trim());
    const definition = { prompt, kind: options.length ? 'multiple_choice' : 'rating', options };
    if (!isQuestionDefinition(definition)) {
      throw new Error(`Line ${index + 1}: provide a question alone, or a question followed by at least two distinct, nonempty pipe-delimited options.`);
    }
    questions.push(definition);
  }
  if (!questions.length) throw new Error('The question file is empty.');
  return questions;
}

export function reconcileQuestions(definitions, previous = []) {
  return definitions.map((definition, index) => {
    if (typeof definition === 'string') {
      const parsed = readQuestions(definition);
      if (parsed.length !== 1) throw new Error('Each question definition must occupy one line.');
      [definition] = parsed;
    }
    if (!isQuestionDefinition(definition)) throw new Error('Invalid question type, prompt, or options.');
    return {
      ordinal: index + 1,
      prompt: definition.prompt,
      kind: definition.kind ?? 'rating',
      options: definition.options ?? [],
      questionToken: previous[index]?.questionToken ?? randomUUID(),
      resultsToken: previous[index]?.resultsToken ?? randomUUID(),
    };
  });
}

export function seedSql(questions) {
  if (!questions.length || questions.some(item => !UUID.test(item.questionToken)
    || !UUID.test(item.resultsToken) || item.questionToken === item.resultsToken
    || !Number.isSafeInteger(item.ordinal) || item.ordinal < 1 || !isQuestionDefinition(item))) {
    throw new Error('Question and results tokens must be independent UUIDs.');
  }
  const tokens = questions.flatMap(item => [item.questionToken, item.resultsToken]);
  if (new Set(tokens).size !== tokens.length) throw new Error('All URL tokens must be unique.');
  const values = questions.map(item => {
    const hash = createHash('sha256').update(item.resultsToken.toLowerCase()).digest('hex');
    const options = `array[${(item.options ?? []).map(sqlText).join(', ')}]::text[]`;
    return `(${sqlText(item.questionToken)}, ${sqlText(hash)}, ${sqlText(item.prompt)}, ${item.ordinal}, true, ${sqlText(item.kind ?? 'rating')}, ${options})`;
  }).join(',\n  ');
  return `begin;\nupdate survey_private.questions set enabled = false;\ninsert into survey_private.questions (question_token, results_hash, prompt, ordinal, enabled, kind, options)\nvalues\n  ${values}\non conflict (question_token) do update set\n  results_hash = excluded.results_hash,\n  prompt = excluded.prompt,\n  ordinal = excluded.ordinal,\n  kind = excluded.kind,\n  options = excluded.options,\n  enabled = true;\ncommit;\n`;
}

export async function makeQr(url, mascotData) {
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'H', margin: 4 });
  const match = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!match) throw new Error('The QR generator returned an unsupported image.');
  const size = Number(match[1]);
  const badgeSize = Math.floor((size - 8) * .18);
  const offset = (size - badgeSize) / 2;
  const inset = badgeSize * .07;
  return svg.replace('<svg ', '<svg role="img" aria-label="Scan to answer this question" ')
    .replace('</svg>', `<rect x="${offset}" y="${offset}" width="${badgeSize}" height="${badgeSize}" rx="1.2" fill="white"/><image href="${mascotData}" x="${offset + inset}" y="${offset + inset}" width="${badgeSize - inset * 2}" height="${badgeSize - inset * 2}"/></svg>`);
}

export async function buildSheet(manifest, mascotData, backgroundData, config = { supabaseUrl: '', publishableKey: '' }) {
  const settings = { supabaseUrl: config.supabaseUrl, publishableKey: config.publishableKey };
  const configured = validateConfig(settings);
  const cards = await Promise.all(manifest.questions.map(async item => {
    const multiple = item.kind === 'multiple_choice';
    const distribution = (multiple ? item.options : [1, 2, 3, 4, 5]).map((label, index) =>
      `<div class="result-row score-${index % COLORS.length + 1}" role="listitem" aria-label="Not loaded">
      <span class="result-score">${escapeHtml(label)}</span><div class="bar-track"><div class="result-bar"></div></div>
      <span class="result-count">--</span><span class="result-percent">--</span></div>`).join('');
    const questionUrl = `${manifest.siteUrl}/#/q/${item.questionToken}`;
    const resultsUrl = `${manifest.siteUrl}/#/r/${item.resultsToken}`;
    return `<article class="card">
      <a class="question-link" href="${escapeHtml(questionUrl)}" target="_blank" rel="noreferrer" aria-label="Open question ${item.ordinal}">
        <div class="qr">${await makeQr(questionUrl, mascotData)}</div></a>
      <div class="question-controls"><h2>${escapeHtml(item.prompt)}</h2>
        <div class="actions"><button class="copy-button" type="button" aria-label="Copy QR image for question ${item.ordinal}">Copy QR image</button>
        <button class="refresh-button" type="button" aria-label="Refresh results for question ${item.ordinal}" data-results-token="${escapeHtml(item.resultsToken)}">Refresh results</button></div>
        <p class="copy-status" role="status" aria-live="polite"></p>
      </div>
      <section class="results${multiple ? ' multiple-results' : ''}" aria-label="Results for question ${item.ordinal}" aria-busy="true">
        <div class="result-metrics"><span><strong class="result-total">--</strong> responses</span><span><strong class="result-secondary">--</strong> <span class="result-secondary-label">${multiple ? 'selections' : 'avg / 5'}</span></span></div>
        <div class="result-chart" role="list" aria-label="Response distribution">${distribution}</div>
        <p class="result-note"${multiple ? '' : ' hidden'}>Multiple selections; % of respondents.</p>
        <div class="result-footer"><p class="result-status" role="status" aria-live="polite">Loading...</p>
        <a class="results-link" href="${escapeHtml(resultsUrl)}" target="_blank" rel="noreferrer">Full results</a></div>
      </section>
    </article>`;
  }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">
<title>PPCC 2026 | Cowork Ate My Agents | Private QR Sheet</title>
<style>
:root{color-scheme:dark;font-family:"Segoe UI",system-ui,sans-serif;background:#080b17;color:#f6f4ff}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#080b17 url("${backgroundData}") center/cover fixed}
header{max-width:1120px;margin:auto;padding:12px 24px 8px;display:flex;justify-content:space-between;align-items:center;gap:16px}
.brand{font-size:.68rem;letter-spacing:.12em;color:#c1acff;font-weight:750;line-height:1.5;margin:0}
.cards{display:grid;gap:10px;max-width:1120px;margin:0 auto;padding:0 24px 12px}
.card{background:#121426d9;border:1px solid #a798d038;border-radius:14px;padding:10px;break-inside:avoid;display:grid;grid-template-columns:144px minmax(180px,1fr) minmax(240px,1.15fr);align-items:center;gap:16px;min-width:0}
.question-controls{display:grid;gap:8px;min-width:0}
h2{font-size:1rem;line-height:1.35;margin:0;overflow-wrap:anywhere;min-height:2.7em}
.question-link{display:block;width:144px;border-radius:10px}
.qr{background:white;border-radius:10px;padding:6px;width:100%}.qr svg{display:block;width:100%;height:auto;image-rendering:pixelated}
.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.results{display:grid;gap:6px;min-width:0;font-variant-numeric:tabular-nums}
.result-metrics{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:#c5c3d6;font-size:.68rem}
.result-metrics strong{color:#f6f4ff;font-size:1.15rem;font-weight:650}
.result-chart{display:grid;gap:3px}
.result-row{display:grid;grid-template-columns:12px minmax(0,1fr) minmax(18px,auto) 30px;align-items:center;gap:6px;font-size:.7rem;line-height:14px}
.result-score{color:var(--score-color)}.bar-track{height:7px;background:#ffffff0c;border-radius:999px;overflow:hidden}
.result-bar{height:100%;width:0;background:var(--score-color);border-radius:999px}
.result-count,.result-percent{text-align:right}.result-percent{color:#b9b6cb}
.multiple-results .result-row{grid-template-columns:minmax(70px,1fr) minmax(0,1fr) minmax(18px,auto) 30px}
.multiple-results .result-score{overflow-wrap:anywhere;line-height:1.35}.result-note{font-size:.64rem;color:#b9b6cb;margin:0}
[hidden]{display:none!important}
${COLORS.map((color, index) => `.score-${index + 1}{--score-color:${color}}`).join('')}
.result-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:16px}
.result-status{font-size:.64rem;line-height:1.4;margin:0;color:#b9b6cb;min-width:0}
.results-link{color:#f3b8df;font-size:.64rem;white-space:nowrap;text-underline-offset:3px}
a:focus-visible,button:focus-visible{outline:3px solid white;outline-offset:3px}
.print-button,.copy-button,.refresh-button{font:inherit;border:1px solid #8174b3;background:#242039;color:white;padding:10px;border-radius:10px;cursor:pointer;min-height:44px;font-size:.78rem}
.print-button{flex-shrink:0}.copy-button{font-weight:650}.refresh-button{border-color:#75506d;color:#f3b8df;background:#231b30}
button:hover{background:#342c50}button:disabled{opacity:.6;cursor:progress}
.copy-status{font-size:.7rem;line-height:1.6;min-height:1.6em;margin:0;color:#86eabe}.has-error{color:#ffc0cf}
@media(max-width:700px){.card{grid-template-columns:144px minmax(0,1fr);gap:12px}.results{grid-column:1/-1}.actions{grid-template-columns:1fr}}
@media print{ :root{color-scheme:light}body{background:white;color:#111}header,.actions,.copy-status,.results{display:none}.cards{grid-template-columns:repeat(2,minmax(0,1fr));padding:0;gap:16px}.card{display:flex;flex-direction:column;background:white;border-color:#ccc;color:#111;padding:14px}.question-controls{order:-1}h2{min-height:0;text-align:center}.question-link{width:min(100%,280px)}.qr{padding:0}}
</style>
</head>
<body>
<header><h1 class="brand">PPCC 2026 | COWORK ATE MY AGENTS</h1>
<button class="print-button" type="button" onclick="window.print()">Print QRs</button></header>
<main class="cards">${cards.join('\n')}</main>
<script>
const config = ${JSON.stringify(settings).replaceAll('<', '\\u003c')};
const configured = ${configured};
const isQuestionDefinition = ${isQuestionDefinition.toString()};
const validateResults = ${validateResults.toString()};

for (const card of document.querySelectorAll('.card')) {
  const button = card.querySelector('.refresh-button');
  const panel = card.querySelector('.results');
  const status = card.querySelector('.result-status');
  if (!configured) {
    button.disabled = true;
    panel.setAttribute('aria-busy', 'false');
    status.classList.add('has-error');
    status.textContent = 'Results not configured. Configure Supabase and regenerate this file.';
    continue;
  }
  let refreshing = false;
  let hasResults = false;
  async function update() {
    if (refreshing) return;
    refreshing = true;
    button.disabled = true;
    panel.setAttribute('aria-busy', 'true');
    status.classList.remove('has-error');
    status.textContent = hasResults ? 'Refreshing...' : 'Loading...';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const headers = { apikey: config.publishableKey, 'Content-Type': 'application/json' };
      if (!config.publishableKey.startsWith('sb_publishable_')) {
        headers.Authorization = 'Bearer ' + config.publishableKey;
      }
      const response = await fetch(config.supabaseUrl.replace(/\\/$/, '') + '/rest/v1/rpc/cowork_results', {
        method: 'POST', headers,
        body: JSON.stringify({ p_results_token: button.dataset.resultsToken }),
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Results request failed (HTTP ' + response.status + ').');
      const data = validateResults(await response.json());
      card.querySelector('h2').textContent = data.prompt;
      card.querySelector('.result-total').textContent = data.total.toLocaleString();
      const multiple = data.kind === 'multiple_choice';
      panel.classList.toggle('multiple-results', multiple);
      card.querySelector('.result-secondary').textContent = multiple
        ? data.distribution.reduce((sum, item) => sum + item.count, 0).toLocaleString()
        : data.average === null ? '--' : data.average.toFixed(1);
      card.querySelector('.result-secondary-label').textContent = multiple ? 'selections' : 'avg / 5';
      card.querySelector('.result-note').hidden = !multiple;
      const chart = card.querySelector('.result-chart');
      chart.replaceChildren();
      data.distribution.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'result-row score-' + (index % 5 + 1);
        row.setAttribute('role', 'listitem');
        const label = document.createElement('span');
        label.className = 'result-score';
        label.textContent = multiple ? item.option : item.score;
        const track = document.createElement('div');
        track.className = 'bar-track';
        const bar = document.createElement('div');
        bar.className = 'result-bar';
        track.append(bar);
        const count = document.createElement('span');
        count.className = 'result-count';
        const percent = document.createElement('span');
        percent.className = 'result-percent';
        row.append(label, track, count, percent);
        chart.append(row);
      });
      card.querySelectorAll('.result-row').forEach((row, index) => {
        const item = data.distribution[index];
        const percentage = data.total ? item.count / data.total * 100 : 0;
        row.querySelector('.result-bar').style.width = percentage + '%';
        row.querySelector('.result-count').textContent = item.count.toLocaleString();
        row.querySelector('.result-percent').textContent = Math.round(percentage) + '%';
        row.setAttribute('aria-label', (multiple ? item.option : item.score + ' out of 5') + ': ' + item.count + ' responses, ' + Math.round(percentage) + ' percent');
      });
      const time = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
      }).format(new Date(data.updatedAt));
      status.textContent = 'Updated ' + time;
      hasResults = true;
    } catch (error) {
      console.error('[survey] Could not refresh results:', error);
      status.classList.add('has-error');
      status.textContent = hasResults ? 'Could not refresh; showing last confirmed results.' : 'Results unavailable. Refresh to retry.';
    } finally {
      clearTimeout(timeout);
      refreshing = false;
      button.disabled = false;
      panel.setAttribute('aria-busy', 'false');
    }
  }
  button.addEventListener('click', update);
  void update();
}

async function qrImage(svg) {
  const image = new Image();
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = svg.viewBox.baseVal.width * 16;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image rendering is unavailable.');
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('Could not create the QR image.')),
    'image/png',
  ));
}

for (const button of document.querySelectorAll('.copy-button')) {
  button.addEventListener('click', async () => {
    const card = button.closest('.card');
    const status = card.querySelector('.copy-status');
    status.classList.remove('has-error');
    status.textContent = '';
    button.disabled = true;
    button.textContent = 'Copying...';
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('Image clipboard access is unavailable.');
      }
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': qrImage(card.querySelector('.qr svg')) }),
      ]);
      status.textContent = 'QR image copied.';
    } catch (error) {
      console.error('[survey] Could not copy QR image:', error);
      status.classList.add('has-error');
      status.textContent = 'Could not copy. Open this file in Microsoft Edge or Chrome and allow clipboard access, then try again.';
    } finally {
      button.disabled = false;
      button.textContent = 'Copy QR image';
    }
  });
}
</script>
</body></html>`;
}

async function main() {
  const input = resolve(process.argv[2] ?? resolve(root, '..', 'questions.txt'));
  const siteUrl = (process.argv[3] ?? 'https://danspot.github.io/cowork-survey').replace(/\/+$/, '');
  const output = resolve(process.argv[4] ?? resolve(root, '..', 'cowork-survey-qr.html'));
  const site = new URL(siteUrl);
  if (site.protocol !== 'https:' || site.search || site.hash) throw new Error('Provide the HTTPS site base URL without a query or fragment.');
  const local = resolve(root, '.local');
  const manifestPath = resolve(local, 'survey.json');
  let previous = [];
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (existing.siteUrl !== siteUrl) throw new Error('The existing QR links use a different site URL. Back up .local before intentionally changing it.');
    previous = existing.questions;
  }
  const prompts = readQuestions(await readFile(input, 'utf8'));
  const manifest = { version: 2, siteUrl, questions: reconcileQuestions(prompts, previous) };
  const seed = seedSql(manifest.questions);
  const mascotData = `data:image/png;base64,${(await readFile(resolve(root, 'web', 'assets', 'cowork.png'))).toString('base64')}`;
  const backgroundData = `data:image/webp;base64,${(await readFile(resolve(root, 'web', 'assets', 'background.webp'))).toString('base64')}`;
  const config = JSON.parse(await readFile(resolve(root, 'web', 'config.json'), 'utf8'));
  const sheet = await buildSheet(manifest, mascotData, backgroundData, config);
  const schema = await readFile(resolve(root, 'supabase', 'schema.sql'), 'utf8');
  await mkdir(local, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(resolve(local, 'setup.sql'), `-- Private generated setup. Do not commit this file.\n${schema}\n${seed}`);
  await writeFile(output, sheet);
  console.log(`Prepared ${prompts.length} questions.\nPrivate QR sheet: ${output}\nSupabase SQL: ${resolve(local, 'setup.sql')}\nPrivate URL manifest: ${manifestPath}`);
  if (previous.length) console.log('Existing question and results URLs were preserved by line position. Removed questions are disabled when setup.sql is rerun.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
