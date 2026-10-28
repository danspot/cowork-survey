import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { UUID } from '../web/shared.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const escapeHtml = text => String(text).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const sqlText = text => `'${text.replaceAll("'", "''")}'`;

export function readQuestions(text) {
  const questions = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!questions.length) throw new Error('The question file is empty.');
  if (questions.some(prompt => prompt.includes('\0') || [...prompt].length > 2000)) {
    throw new Error('Each question must be one line of at most 2,000 characters, without null bytes.');
  }
  return questions;
}

export function reconcileQuestions(prompts, previous = []) {
  return prompts.map((prompt, index) => ({
    ordinal: index + 1,
    prompt,
    questionToken: previous[index]?.questionToken ?? randomUUID(),
    resultsToken: previous[index]?.resultsToken ?? randomUUID(),
  }));
}

export function seedSql(questions) {
  if (!questions.length || questions.some(item => !UUID.test(item.questionToken)
    || !UUID.test(item.resultsToken) || item.questionToken === item.resultsToken
    || !Number.isSafeInteger(item.ordinal) || item.ordinal < 1)) {
    throw new Error('Question and results tokens must be independent UUIDs.');
  }
  const tokens = questions.flatMap(item => [item.questionToken, item.resultsToken]);
  if (new Set(tokens).size !== tokens.length) throw new Error('All URL tokens must be unique.');
  const values = questions.map(item => {
    const hash = createHash('sha256').update(item.resultsToken.toLowerCase()).digest('hex');
    return `(${sqlText(item.questionToken)}, ${sqlText(hash)}, ${sqlText(item.prompt)}, ${item.ordinal}, true)`;
  }).join(',\n  ');
  return `begin;\nupdate survey_private.questions set enabled = false;\ninsert into survey_private.questions (question_token, results_hash, prompt, ordinal, enabled)\nvalues\n  ${values}\non conflict (question_token) do update set\n  results_hash = excluded.results_hash,\n  prompt = excluded.prompt,\n  ordinal = excluded.ordinal,\n  enabled = true;\ncommit;\n`;
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

export async function buildSheet(manifest, mascotData, backgroundData) {
  const cards = await Promise.all(manifest.questions.map(async item => {
    const questionUrl = `${manifest.siteUrl}/#/q/${item.questionToken}`;
    const resultsUrl = `${manifest.siteUrl}/#/r/${item.resultsToken}`;
    return `<article class="card">
      <div class="card-heading"><span class="tag">QUESTION ${item.ordinal}</span><h2>${escapeHtml(item.prompt)}</h2></div>
      <div class="qr">${await makeQr(questionUrl, mascotData)}</div>
      <p class="scan-label">SCAN. TAP A NUMBER. YOU'RE COUNTED.</p>
      <div class="links"><a class="question-link" href="${escapeHtml(questionUrl)}" target="_blank" rel="noreferrer">Open question <span aria-hidden="true">&#8599;</span></a>
      <a class="results-link" href="${escapeHtml(resultsUrl)}" target="_blank" rel="noreferrer">View private results <span aria-hidden="true">&#8599;</span></a></div>
      <details><summary>Show full links</summary><p><strong>Question</strong><br><a href="${escapeHtml(questionUrl)}">${escapeHtml(questionUrl)}</a></p><p><strong>Results - keep private</strong><br><a href="${escapeHtml(resultsUrl)}">${escapeHtml(resultsUrl)}</a></p></details>
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
header{max-width:1180px;margin:auto;padding:45px 28px 25px}.brand{font-size:.72rem;letter-spacing:.2em;color:#c1acff;font-weight:750}
.hero{display:flex;gap:14px;align-items:center}.hero img{width:100px;height:100px;object-fit:contain}
h1{font-size:clamp(1.8rem,5vw,2.7rem);letter-spacing:-.04em;margin:8px 0}header p{max-width:760px;color:#c5c3d6;line-height:1.6;margin:4px 0 12px}
.notice{padding:12px 16px;border:1px solid #756091;border-radius:12px;background:#23172f;color:#f0d7ef;font-size:.85rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:22px;max-width:1180px;margin:0 auto;padding:10px 28px 45px}
.card{background:#121426d9;border:1px solid #a798d038;border-radius:22px;padding:24px;break-inside:avoid;display:flex;flex-direction:column;text-align:center}
.tag{font-size:.64rem;letter-spacing:.18em;color:#c1acff;font-weight:750}h2{font-size:1.18rem;line-height:1.4;margin:12px 0 22px;overflow-wrap:anywhere;min-height:3em}
.qr{background:white;border-radius:16px;padding:14px;max-width:340px;width:100%;margin:auto auto 0}.qr svg{display:block;width:100%;height:auto;image-rendering:pixelated}
.scan-label{font-size:.55rem;letter-spacing:.12em;color:#c3bfd5;margin:16px 0 18px}
.links{display:grid;gap:9px}.links a{display:flex;justify-content:space-between;align-items:center;min-height:46px;padding:12px 15px;border-radius:11px;text-decoration:none;font-size:.8rem;font-weight:650}
.question-link{background:#292c4b;color:#e5e3ff;border:1px solid #696285}.results-link{background:#231b30;color:#f3b8df;border:1px solid #75506d}
details{text-align:left;margin-top:18px;font-size:.7rem;line-height:1.6;color:#b9b6cb}summary{cursor:pointer;min-height:32px;padding:7px 0}details a{color:#b4d7ff;overflow-wrap:anywhere}
a:focus-visible,summary:focus-visible{outline:3px solid white;outline-offset:3px}
.print-button{font:inherit;border:1px solid #8174b3;background:#242039;color:white;padding:11px 18px;border-radius:999px;cursor:pointer;margin-top:12px}
footer{text-align:center;color:#aaa6bf;font-size:.75rem;padding:0 20px 30px}
@media print{ :root{color-scheme:light}body{background:white;color:#111}header{padding-top:12px}header p,.brand{color:#333}.notice,.print-button,details,.links,.scan-label,footer{display:none}.cards{grid-template-columns:repeat(2,minmax(0,1fr));padding:0;gap:16px}.card{background:white;border-color:#ccc;color:#111;padding:14px}.tag{color:#555}h2{min-height:0}.qr{max-width:280px;padding:0}.hero img{width:65px;height:65px}h1{font-size:26px}}
</style>
</head>
<body>
<header><p class="brand">PPCC 2026 | COWORK ATE MY AGENTS</p><div class="hero"><img src="${mascotData}" alt="" width="100" height="100"><h1>Small taps. Big feedback.</h1></div>
<p>Your presenter sheet: one question, one QR, and one separate results link. Save this file locally; its QRs and artwork work without an internet connection. Responding and viewing results require internet access.</p>
<p class="notice"><strong>Keep this file private.</strong> It contains every results link. Do not publish it to GitHub or share it with attendees. Print hides private links; share an individual QR image instead.</p>
<button class="print-button" type="button" onclick="window.print()">Print attendee QR sheets</button></header>
<main class="cards">${cards.join('\n')}</main>
<footer>Five numbers. One tap. A better next move.</footer>
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
  const manifest = { version: 1, siteUrl, questions: reconcileQuestions(prompts, previous) };
  const seed = seedSql(manifest.questions);
  const mascotData = `data:image/png;base64,${(await readFile(resolve(root, 'web', 'assets', 'cowork.png'))).toString('base64')}`;
  const backgroundData = `data:image/webp;base64,${(await readFile(resolve(root, 'web', 'assets', 'background.webp'))).toString('base64')}`;
  const sheet = await buildSheet(manifest, mascotData, backgroundData);
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
