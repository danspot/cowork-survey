import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../web/shared.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [supabaseUrl, publishableKey, ...extra] = process.argv.slice(2);
try {
  if (!supabaseUrl || !publishableKey || extra.length) {
    throw new Error('Usage: npm run configure -- https://PROJECT.supabase.co BROWSER_SAFE_PUBLISHABLE_KEY');
  }
  const config = { supabaseUrl: supabaseUrl.replace(/\/+$/, ''), publishableKey };
  if (!validateConfig(config)) throw new Error('Supabase details are required.');
  await writeFile(resolve(root, 'web', 'config.json'), JSON.stringify(config, null, 2) + '\n');
  console.log('Browser-safe configuration saved. Run .local\\setup.sql in the Supabase SQL Editor, then commit and push web\\config.json to activate the site.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
