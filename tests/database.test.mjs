import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { reconcileQuestions, seedSql } from '../tools/prepare.mjs';
import { validateResults } from '../web/shared.js';

test('real PostgreSQL schema enforces isolated, immutable anonymous votes', async context => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated;');
    await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
    const questions = reconcileQuestions(["What's your take?", 'A second question']);
    await db.exec(seedSql(questions));
    const [first, second] = questions;
    const browser = randomUUID();
    const unknown = randomUUID();
    const call = async (operation, values) => {
      const placeholders = values.map((value, index) => `$${index + 1}`).join(', ');
      const { rows } = await db.query(`select public.${operation}(${placeholders}) as value`, values);
      return rows[0].value;
    };
    const question = (token, identity = browser) => call('cowork_question', [token, identity]);
    const vote = (token, identity, score) => call('cowork_vote', [token, identity, score]);
    const results = token => call('cowork_results', [token]);
    await db.exec('set role anon');

    await context.test('only bearer-token RPCs are accessible', async () => {
      assert.deepEqual(await question(first.questionToken), { prompt: first.prompt, score: null });
      for (const token of [unknown, first.resultsToken]) await assert.rejects(question(token), { code: 'P0002' });
      for (const token of [unknown, first.questionToken]) await assert.rejects(results(token), { code: 'P0002' });
      await assert.rejects(db.query('select * from survey_private.questions'), { code: '42501' });
      await assert.rejects(db.query('select * from survey_private.responses'), { code: '42501' });
      await assert.rejects(db.query('insert into survey_private.responses values ($1,$2,5,now())', [first.questionToken, 'x'.repeat(64)]), { code: '42501' });
    });

    await context.test('empty results contain all five zero buckets', async () => {
      const empty = validateResults(await results(first.resultsToken));
      assert.equal(empty.total, 0);
      assert.equal(empty.average, null);
      assert.deepEqual(empty.distribution, [1, 2, 3, 4, 5].map(score => ({ score, count: 0 })));
    });

    await context.test('bad scores, absent identities, and unknown questions never insert', async () => {
      for (const score of [null, 0, 6, -1]) {
        await assert.rejects(vote(first.questionToken, browser, score), { code: '22023' });
      }
      await assert.rejects(vote(first.questionToken, null, 2), { code: '22023' });
      await assert.rejects(vote(unknown, browser, 2), { code: 'P0002' });
      assert.equal((await results(first.resultsToken)).total, 0);
    });

    await context.test('the first answer is final, even when requests are repeated', async () => {
      assert.deepEqual(await vote(first.questionToken, browser, 1), { recorded: true, score: 1 });
      assert.deepEqual(await vote(first.questionToken, browser, 5), { recorded: false, score: 1 });
      assert.deepEqual(await vote(first.questionToken, browser, 1), { recorded: false, score: 1 });
      assert.equal((await question(first.questionToken)).score, 1);
      assert.deepEqual(await vote(first.questionToken, randomUUID(), 2), { recorded: true, score: 2 });
      assert.deepEqual(await vote(first.questionToken, randomUUID(), 5), { recorded: true, score: 5 });
      const summary = validateResults(await results(first.resultsToken));
      assert.equal(summary.total, 3);
      assert.ok(Math.abs(summary.average - 8 / 3) < 1e-10);
      assert.deepEqual(summary.distribution.map(item => item.count), [1, 1, 0, 0, 1]);
    });

    await context.test('questions and results remain isolated from one another', async () => {
      assert.equal((await question(second.questionToken)).score, null);
      await vote(second.questionToken, browser, 4);
      const summary = await results(second.resultsToken);
      assert.equal(summary.total, 1);
      assert.equal(summary.average, 4);
      assert.equal((await results(first.resultsToken)).total, 3);
      await db.exec('reset role');
      const { rows } = await db.query('select voter_hash from survey_private.responses where question_token in ($1,$2) and score in (1,4)', [first.questionToken, second.questionToken]);
      assert.notEqual(rows[0].voter_hash, rows[1].voter_hash);
      await db.exec('set role anon');
    });

    await context.test('authenticated users do not inherit anonymous function execution', async () => {
      await db.exec('reset role; set role authenticated');
      await assert.rejects(question(first.questionToken), { code: '42501' });
      await db.exec('reset role; set role anon');
    });

    await context.test('reprovisioning preserves votes and closes removed questions', async () => {
      await db.exec('reset role');
      await db.exec(seedSql([{ ...first, prompt: 'Updated text' }]));
      await db.exec('set role anon');
      assert.equal((await question(first.questionToken)).prompt, 'Updated text');
      assert.equal((await results(first.resultsToken)).total, 3);
      await assert.rejects(question(second.questionToken), { code: 'P0002' });
      await assert.rejects(vote(second.questionToken, randomUUID(), 5), { code: 'P0002' });
      await assert.rejects(results(second.resultsToken), { code: 'P0002' });
    });
  } finally {
    await db.close();
  }
});
