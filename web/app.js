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
  section.append(mascot());
  if (eyebrow) section.append(element('p', 'eyebrow', eyebrow));
  section.append(element('h1', '', title));
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

function animateAnswer(button) {
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    button.animate([
      { transform: 'scale(.92)', filter: 'drop-shadow(0 0 0 #c1acff00)' },
      { transform: 'scale(1.15)', filter: 'drop-shadow(0 0 20px #c1acffaa)', offset: .45 },
      { transform: 'scale(1.06)', filter: 'drop-shadow(0 0 12px #c1acff77)' },
    ], { duration: 480, easing: 'ease-out' });
  }
}

function showMultipleQuestion(config, route, current, question, identity) {
  const section = panel(null, question.prompt);
  const form = element('form', 'multiple-form');
  const choices = element('fieldset', 'multiple-choices');
  choices.setAttribute('aria-label', 'Choose one or more options');
  const status = element('div', 'vote-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const save = element('button', 'utility-button save-answer', 'Save answer');
  save.type = 'submit';
  let busy = false;
  let saved = [...question.selections];
  const inputs = question.options.map((option, index) => {
    const label = element('label', `option-choice option-${index % 5 + 1}`);
    const input = element('input');
    input.type = 'checkbox';
    input.value = option;
    input.checked = saved.includes(option);
    label.append(input, element('span', 'option-label', option));
    choices.append(label);
    input.addEventListener('change', () => {
      status.classList.remove('has-error');
      const draft = selection();
      if (draft.length === saved.length && draft.every(value => saved.includes(value))) {
        if (saved.length) showSaved('Your response is saved.');
        else status.textContent = '';
      } else {
        status.textContent = draft.length ? 'Changes not saved.' : 'Select at least one option.';
      }
      update();
    });
    return input;
  });
  const selection = () => inputs.filter(input => input.checked).map(input => input.value);
  function update() {
    const draft = selection();
    choices.disabled = busy;
    choices.setAttribute('aria-busy', String(busy));
    save.disabled = busy || !draft.length || (draft.length === saved.length && draft.every(value => saved.includes(value)));
  }
  function showSaved(title) {
    status.replaceChildren(
      element('p', 'success-title', title),
      element('p', 'success-detail', `${saved.length} ${saved.length === 1 ? 'option' : 'options'} selected.`),
    );
    section.classList.add('answered');
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || save.disabled) return;
    const selected = selection();
    busy = true;
    update();
    animateAnswer(save);
    status.classList.remove('has-error');
    status.textContent = 'Saving your answer...';
    try {
      const answer = validateVote(await rpc(config, 'cowork_choose', {
        p_question_token: route.token, p_browser_token: identity, p_selections: selected,
      }), question);
      if (current !== generation) return;
      if (answer.selections.length !== selected.length || !selected.every(value => answer.selections.includes(value))) {
        throw new Error('The server did not save the selected options.');
      }
      const wasSaved = saved.length > 0;
      saved = answer.selections;
      showSaved(wasSaved ? 'Answer updated.' : 'You\'re counted. Thank you!');
    } catch (error) {
      if (current !== generation) return;
      console.error('[survey] Could not confirm response:', error.message);
      status.classList.add('has-error');
      status.textContent = 'We couldn\'t confirm your answer. Save again to retry safely; you will not be counted twice.';
    } finally {
      busy = false;
      if (current === generation) update();
    }
  });
  form.append(element('p', 'choice-hint', 'Select all that apply.'), choices, save, status);
  section.append(form);
  if (saved.length) showSaved('Your response is saved.');
  update();
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
  if (question.editable !== true) {
    showError('This survey is being updated.', 'Please try again in a moment.', start);
    return;
  }
  if (question.kind === 'multiple_choice') {
    showMultipleQuestion(config, route, current, question, identity);
    return;
  }
  const section = panel(null, question.prompt);
  const choices = element('div', 'choices');
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', 'Your rating, from 1 to 5');
  const status = element('div', 'vote-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  let busy = false;
  let saved = question.score;
  const buttons = [];

  function updateButtons() {
    buttons.forEach((button, index) => {
      button.disabled = busy;
      button.classList.toggle('selected', saved === index + 1);
      button.classList.toggle('not-selected', saved !== null && saved !== index + 1);
      button.setAttribute('aria-pressed', String(saved === index + 1));
    });
    choices.setAttribute('aria-busy', String(busy));
  }

  function showSaved(title) {
    status.replaceChildren(
      element('p', 'success-title', title),
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
      if (busy) return;
      busy = true;
      updateButtons();
      animateAnswer(button);
      status.classList.remove('has-error');
      status.textContent = 'Saving your answer...';
      try {
        const answer = validateVote(await rpc(config, 'cowork_vote', {
          p_question_token: route.token, p_browser_token: identity, p_score: score,
        }));
        if (current !== generation) return;
        if (answer.score !== score) throw new Error('The server did not save the selected answer.');
        const wasSaved = saved !== null;
        saved = answer.score;
        showSaved(wasSaved ? 'Answer updated.' : 'You\'re counted. Thank you!');
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
  section.append(choices, status);
  if (saved !== null) showSaved('Your response is saved.');
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
  const secondaryLabel = element('span', 'metric-label');
  totalBlock.append(total, element('span', 'metric-label', 'RESPONSES'));
  averageBlock.append(average, secondaryLabel);
  metrics.append(totalBlock, averageBlock);
  const chart = element('div', 'chart');
  chart.setAttribute('role', 'list');
  chart.setAttribute('aria-label', 'Response distribution');
  const note = element('p', 'fine-print selection-note', 'Multiple selections allowed. Percentages are per respondent.');
  const freshness = element('p', 'freshness');
  freshness.setAttribute('role', 'status');
  const refresh = element('button', 'utility-button', 'Refresh now');
  const actions = element('div', 'results-actions');
  actions.append(freshness, refresh);
  section.append(metrics, chart, note, actions,
    element('p', 'fine-print', 'Live counts refresh every 5 seconds. Keep this results link private.'));

  function render() {
    const multiple = data.kind === 'multiple_choice';
    section.querySelector('h1').textContent = data.prompt;
    total.textContent = data.total.toLocaleString();
    average.textContent = multiple ? data.distribution.reduce((sum, item) => sum + item.count, 0).toLocaleString()
      : data.average === null ? '--' : data.average.toFixed(1);
    secondaryLabel.textContent = multiple ? 'SELECTIONS' : 'AVERAGE / 5';
    note.hidden = !multiple;
    chart.replaceChildren();
    data.distribution.forEach((item, index) => {
      const percentage = data.total ? item.count / data.total * 100 : 0;
      const row = element('div', `chart-row${multiple ? ' multiple-row' : ''}`);
      row.setAttribute('role', 'listitem');
      const label = element('span', 'chart-label');
      if (multiple) label.textContent = item.option;
      else label.innerHTML = digitSvg(item.score);
      const track = element('div', 'bar-track');
      const bar = element('div', `bar bar-${index % 5 + 1}`);
      bar.style.width = `${percentage}%`;
      track.append(bar);
      row.append(label, track, element('span', 'bar-count', item.count.toLocaleString()),
        element('span', 'bar-percent', `${Math.round(percentage)}%`));
      row.setAttribute('aria-label', `${multiple ? item.option : `${item.score} out of 5`}: ${item.count} responses, ${Math.round(percentage)} percent`);
      chart.append(row);
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
    panel('MAKE YOUR NEXT MOVE.', 'A little feedback goes a long way.', 'Scan a question\'s QR code to share your take.');
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
