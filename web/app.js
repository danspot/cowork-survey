import { UUID, digitSvg, parseRoute, validateConfig, validateQuestion, validateResults, validateVote } from './shared.js';

const app = document.querySelector('#app');
let generation = 0;
let refreshTimer;
let refreshCurrent;

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function mascot() {
  const scene = element('div', 'mascot-scene');
  const image = element('img', 'mascot');
  image.src = new URL('assets/cowork.png', import.meta.url).href;
  image.alt = '';
  image.width = 128;
  image.height = 128;
  scene.append(image, element('span', 'pellets'));
  scene.setAttribute('aria-hidden', 'true');
  return scene;
}

function panel(eyebrow, title, description) {
  const section = element('section', 'panel');
  section.append(mascot(), element('p', 'eyebrow', eyebrow), element('h1', '', title));
  if (description) section.append(element('p', 'description', description));
  app.replaceChildren(section);
  app.setAttribute('aria-busy', 'false');
  return section;
}

function showError(title, message, retry) {
  const section = panel('LET\'S TRY THAT AGAIN', title, message);
  if (retry) {
    const button = element('button', 'utility-button', 'Try again');
    button.addEventListener('click', retry);
    section.append(button);
  }
}

function browserToken() {
  const key = 'cowork-survey-browser-v1';
  let token = localStorage.getItem(key);
  if (!token || !UUID.test(token)) {
    token = crypto.randomUUID();
    localStorage.setItem(key, token);
    if (localStorage.getItem(key) !== token) throw new Error('Browser storage is unavailable.');
  }
  return token;
}

async function rpc(config, operation, parameters) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = { apikey: config.publishableKey, 'Content-Type': 'application/json' };
    if (!config.publishableKey.startsWith('sb_publishable_')) {
      headers.Authorization = `Bearer ${config.publishableKey}`;
    }
    const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${operation}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(parameters),
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = {};
      try {
        detail = await response.json();
      } catch {
        // A gateway error can have a non-JSON body.
      }
      const error = new Error(`Survey request failed (${response.status}).`);
      error.notFound = detail.code === 'P0002';
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function showQuestion(config, route, current) {
  let identity;
  try {
    identity = browserToken();
  } catch (error) {
    console.error('[survey] Browser storage unavailable:', error.message);
    showError('Browser storage is needed.', 'Please allow local storage in your browser, then reopen this link. It keeps your one response from being submitted twice.', start);
    return;
  }
  const question = validateQuestion(await rpc(config, 'cowork_question', {
    p_question_token: route.token, p_browser_token: identity,
  }));
  if (current !== generation) return;
  const section = panel('YOUR TAKE. ONE TAP.', question.prompt, 'Choose a number from 1 to 5.');
  const choices = element('div', 'choices');
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', 'Your rating, from 1 to 5');
  const status = element('div', 'vote-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const note = element('p', 'fine-print', 'Anonymous. One response per browser. Your answer is final.');
  let busy = false;
  let saved = question.score;
  const buttons = [];

  function updateButtons() {
    buttons.forEach((button, index) => {
      button.disabled = busy || saved !== null;
      button.classList.toggle('selected', saved === index + 1);
      button.classList.toggle('not-selected', saved !== null && saved !== index + 1);
      button.setAttribute('aria-pressed', String(saved === index + 1));
    });
    choices.setAttribute('aria-busy', String(busy));
  }

  function thankYou(alreadySaved) {
    status.replaceChildren(
      element('p', 'success-title', alreadySaved ? 'You\'re already counted.' : 'You\'re counted. Thank you!'),
      element('p', 'success-detail', `Your answer: ${saved} out of 5.`),
    );
    section.classList.add('answered');
    updateButtons();
  }

  for (let score = 1; score <= 5; score++) {
    const button = element('button', 'score-button');
    button.type = 'button';
    button.innerHTML = digitSvg(score);
    button.setAttribute('aria-label', `${score} out of 5`);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', async () => {
      if (busy || saved !== null) return;
      busy = true;
      updateButtons();
      status.classList.remove('has-error');
      status.textContent = 'Saving your answer...';
      try {
        const answer = validateVote(await rpc(config, 'cowork_vote', {
          p_question_token: route.token, p_browser_token: identity, p_score: score,
        }));
        if (current !== generation) return;
        saved = answer.score;
        thankYou(!answer.recorded);
      } catch (error) {
        if (current !== generation) return;
        console.error('[survey] Could not confirm response:', error.message);
        status.classList.add('has-error');
        status.textContent = 'We couldn\'t confirm your answer. Tap a number to retry safely; you will not be counted twice.';
      } finally {
        busy = false;
        if (current === generation) updateButtons();
      }
    });
    buttons.push(button);
    choices.append(button);
  }
  section.append(choices, status, note);
  if (saved !== null) thankYou(true);
  else updateButtons();
}

async function showResults(config, route, current) {
  let data = validateResults(await rpc(config, 'cowork_results', { p_results_token: route.token }));
  if (current !== generation) return;
  const section = panel('THE ROOM, IN REAL TIME.', data.prompt);
  section.classList.add('results-panel');
  const metrics = element('div', 'metrics');
  const total = element('strong', 'metric-value');
  const average = element('strong', 'metric-value');
  const totalBlock = element('div', 'metric');
  const averageBlock = element('div', 'metric');
  totalBlock.append(total, element('span', 'metric-label', 'RESPONSES'));
  averageBlock.append(average, element('span', 'metric-label', 'AVERAGE / 5'));
  metrics.append(totalBlock, averageBlock);
  const chart = element('div', 'chart');
  chart.setAttribute('role', 'list');
  chart.setAttribute('aria-label', 'Response distribution');
  const rows = [];
  for (let score = 1; score <= 5; score++) {
    const row = element('div', 'chart-row');
    row.setAttribute('role', 'listitem');
    const label = element('span', 'chart-label');
    label.innerHTML = digitSvg(score);
    const track = element('div', 'bar-track');
    const bar = element('div', `bar bar-${score}`);
    track.append(bar);
    const count = element('span', 'bar-count');
    const percent = element('span', 'bar-percent');
    row.append(label, track, count, percent);
    chart.append(row);
    rows.push({ row, bar, count, percent });
  }
  const freshness = element('p', 'freshness');
  freshness.setAttribute('role', 'status');
  const refresh = element('button', 'utility-button', 'Refresh now');
  const actions = element('div', 'results-actions');
  actions.append(freshness, refresh);
  section.append(metrics, chart, actions,
    element('p', 'fine-print', 'Live counts refresh every 5 seconds. Keep this results link private.'));

  function render() {
    total.textContent = data.total.toLocaleString();
    average.textContent = data.average === null ? '--' : data.average.toFixed(1);
    data.distribution.forEach((item, index) => {
      const percentage = data.total ? item.count / data.total * 100 : 0;
      const row = rows[index];
      row.bar.style.width = `${percentage}%`;
      row.count.textContent = item.count.toLocaleString();
      row.percent.textContent = `${Math.round(percentage)}%`;
      row.row.setAttribute('aria-label', `${item.score} out of 5: ${item.count} responses, ${Math.round(percentage)} percent`);
    });
    const time = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).format(new Date(data.updatedAt));
    freshness.textContent = `Updated ${time}`;
    freshness.classList.remove('has-error');
  }

  let refreshing = false;
  async function update() {
    if (current !== generation || document.hidden || refreshing) return;
    refreshing = true;
    clearTimeout(refreshTimer);
    refresh.disabled = true;
    let delay = 5000;
    try {
      data = validateResults(await rpc(config, 'cowork_results', { p_results_token: route.token }));
      if (current === generation) render();
    } catch (error) {
      if (current !== generation) return;
      console.error('[survey] Results refresh failed:', error.message);
      freshness.classList.add('has-error');
      freshness.textContent = 'Couldn\'t refresh. Showing last confirmed results.';
      delay = 15000;
    } finally {
      refreshing = false;
      refresh.disabled = false;
      if (current === generation) refreshTimer = setTimeout(update, delay);
    }
  }
  render();
  refresh.addEventListener('click', update);
  refreshCurrent = update;
  refreshTimer = setTimeout(update, 5000);
}

async function start() {
  const current = ++generation;
  clearTimeout(refreshTimer);
  refreshCurrent = undefined;
  const route = parseRoute(location.hash);
  if (!location.hash || location.hash === '#') {
    panel('MAKE YOUR NEXT MOVE.', 'A little feedback goes a long way.', 'Scan a question\'s QR code to share your take. Five numbers. One tap. That\'s it.');
    return;
  }
  if (!route) {
    showError('This link isn\'t valid.', 'Scan the original QR code, or reopen the complete link you were given.');
    return;
  }
  app.setAttribute('aria-busy', 'true');
  app.replaceChildren(element('p', 'loading', 'Getting ready...'));
  try {
    const response = await fetch(new URL('config.json', import.meta.url), { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load the survey configuration.');
    const config = await response.json();
    if (current !== generation) return;
    if (!validateConfig(config)) {
      panel('ALMOST READY.', 'This survey isn\'t live yet.', 'Response storage hasn\'t been connected. Please check back when your presenter opens the survey.');
      return;
    }
    if (route.view === 'q') await showQuestion(config, route, current);
    else await showResults(config, route, current);
  } catch (error) {
    if (current !== generation) return;
    console.error('[survey] Could not open page:', error.message);
    if (error.notFound) showError('This link isn\'t active.', 'Ask your presenter for the current QR code or results link.');
    else showError('We couldn\'t connect.', 'Please check your connection and try again. The survey service may be temporarily unavailable.', start);
  }
}

window.addEventListener('hashchange', start);
document.addEventListener('visibilitychange', () => {
  clearTimeout(refreshTimer);
  if (!document.hidden && refreshCurrent) void refreshCurrent();
});
void start();
