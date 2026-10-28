export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const COLORS = ['#6ec3ff', '#86eabe', '#c1acff', '#99b7ff', '#f3a3dc'];
export const DIGITS = [
  '00100/01100/00100/00100/00100/00100/01110',
  '01110/10001/00001/00010/00100/01000/11111',
  '11110/00001/00001/01110/00001/00001/11110',
  '00010/00110/01010/10010/11111/00010/00010',
  '11111/10000/10000/11110/00001/00001/11110',
];

export function digitSvg(score) {
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error('Invalid score.');
  const dots = DIGITS[score - 1].split('/').flatMap((row, y) => [...row].flatMap((bit, x) =>
    bit === '1' ? [`<circle cx="${34 + x * 7}" cy="${27 + y * 7}" r="2.35"/>`] : []));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" aria-hidden="true" focusable="false"><circle class="token-disc" cx="48" cy="48" r="43" fill="#161d3b" stroke="${COLORS[score - 1]}" stroke-width="2"/><g fill="${COLORS[score - 1]}">${dots.join('')}</g></svg>`;
}

export function parseRoute(hash) {
  const match = /^#\/(q|r)\/([^/]+)\/?$/.exec(hash);
  return match && UUID.test(match[2]) ? { view: match[1], token: match[2].toLowerCase() } : null;
}

export function validateConfig(config) {
  if (!config || typeof config.supabaseUrl !== 'string' || typeof config.publishableKey !== 'string') {
    throw new Error('The survey configuration is invalid.');
  }
  if (!config.supabaseUrl && !config.publishableKey) return false;
  const url = new URL(config.supabaseUrl);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTPS Supabase project URL.');
  }
  if (!/^sb_publishable_[a-zA-Z0-9_-]{16,}$/.test(config.publishableKey)) {
    const parts = config.publishableKey.split('.');
    let payload;
    try {
      const base64 = parts[1]?.replaceAll('-', '+').replaceAll('_', '/');
      payload = JSON.parse(atob(base64));
    } catch {
      throw new Error('Use a browser-safe publishable key or legacy anon key, never an admin key.');
    }
    if (parts.length !== 3 || payload.role !== 'anon') {
      throw new Error('Only a publishable key or legacy anon key is allowed.');
    }
  }
  return true;
}

export function validateQuestion(data) {
  if (!data || typeof data.prompt !== 'string' || !data.prompt.trim()
    || !(data.score === null || (Number.isInteger(data.score) && data.score >= 1 && data.score <= 5))) {
    throw new Error('The server returned an invalid question.');
  }
  return data;
}

export function validateVote(data) {
  if (!data || data.recorded !== true
    || !Number.isInteger(data.score) || data.score < 1 || data.score > 5) {
    throw new Error('The server did not confirm the response.');
  }
  return data;
}

export function validateResults(data) {
  if (!data || typeof data.prompt !== 'string' || !data.prompt.trim()
    || !Number.isSafeInteger(data.total) || data.total < 0
    || !Array.isArray(data.distribution) || data.distribution.length !== 5
    || !data.distribution.every((row, index) => row.score === index + 1
      && Number.isSafeInteger(row.count) && row.count >= 0)
    || data.distribution.reduce((total, row) => total + row.count, 0) !== data.total
    || (data.total === 0 ? data.average !== null
      : typeof data.average !== 'number' || !Number.isFinite(data.average)
        || Math.abs(data.average - data.distribution.reduce((sum, row) => sum + row.score * row.count, 0) / data.total) > .000001)
    || typeof data.updatedAt !== 'string'
    || !/(?:Z|[+-]\d{2}:\d{2})$/.test(data.updatedAt)
    || !Number.isFinite(Date.parse(data.updatedAt))) {
    throw new Error('The server returned invalid results.');
  }
  return data;
}
