import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { readQuestions, reconcileQuestions, seedSql } from '../tools/prepare.mjs';
import { validateResults } from '../web/shared.js';

test('real PostgreSQL schema keeps one editable anonymous response per browser', async context => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated;');
    await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
    const questions = reconcileQuestions(readQuestions("What's your take?\nA second question\nPick tools | Cowork | Agents | Both, sometimes"));
    await db.exec(seedSql(questions));
    const [first, second, multiple] = questions;
    const browser = randomUUID();
    const unknown = randomUUID();
    const call = async (operation, values) => {
      const placeholders = values.map((value, index) => `$${index + 1}`).join(', ');
      const { rows } = await db.query(`select public.${operation}(${placeholders}) as value`, values);
      return rows[0].value;
    };
    const question = (token, identity = browser) => call('cowork_question', [token, identity]);
    const vote = (token, identity, score) => call('cowork_vote', [token, identity, score]);
    const choose = (token, identity, selections) => call('cowork_choose', [token, identity, selections]);
    const results = token => call('cowork_results', [token]);
    await db.exec('set role anon');

    await context.test('only bearer-token RPCs are accessible', async () => {
      assert.deepEqual(await question(first.questionToken), { prompt: first.prompt, kind: 'rating', options: [], score: null, selections: [], editable: true });
      for (const token of [unknown, first.resultsToken]) await assert.rejects(question(token), { code: 'P0002' });
      for (const token of [unknown, first.questionToken]) await assert.rejects(results(token), { code: 'P0002' });
      await assert.rejects(db.query('select * from survey_private.questions'), { code: '42501' });
      await assert.rejects(db.query('select * from survey_private.responses'), { code: '42501' });
      await assert.rejects(db.query('insert into survey_private.responses values ($1,$2,5,now())', [first.questionToken, 'x'.repeat(64)]), { code: '42501' });
    });

    await context.test('multi-select responses are validated, editable, and counted by respondent', async () => {
      const empty = validateResults(await results(multiple.resultsToken));
      assert.equal(empty.total, 0);
      assert.equal(empty.average, null);
      assert.deepEqual(empty.distribution, multiple.options.map(option => ({ option, count: 0 })));
      for (const selections of [null, [], ['Missing'], ['Cowork', 'Cowork'], ['Cowork', null], [['Cowork', 'Agents']]]) {
        await assert.rejects(choose(multiple.questionToken, browser, selections), { code: '22023' });
      }
      await assert.rejects(choose(multiple.questionToken, null, ['Cowork']), { code: '22023' });
      await assert.rejects(choose(unknown, browser, ['Cowork']), { code: 'P0002' });
      await assert.rejects(choose(first.questionToken, browser, ['Cowork']), { code: '22023' });
      await assert.rejects(vote(multiple.questionToken, browser, 2), { code: '22023' });
      assert.equal((await results(multiple.resultsToken)).total, 0);
      assert.deepEqual(await choose(multiple.questionToken, browser, ['Agents', 'Cowork']), {
        kind: 'multiple_choice', recorded: true, selections: ['Cowork', 'Agents'],
      });
      assert.deepEqual((await question(multiple.questionToken)).selections, ['Cowork', 'Agents']);
      await choose(multiple.questionToken, browser, ['Agents', 'Cowork']);
      await choose(multiple.questionToken, randomUUID(), ['Cowork']);
      let data = validateResults(await results(multiple.resultsToken));
      assert.equal(data.total, 2);
      assert.equal(data.average, null);
      assert.deepEqual(data.distribution.map(row => row.count), [2, 1, 0]);
      await choose(multiple.questionToken, browser, ['Both, sometimes']);
      data = validateResults(await results(multiple.resultsToken));
      assert.equal(data.total, 2);
      assert.deepEqual(data.distribution.map(row => row.count), [1, 0, 1]);
      assert.equal((await results(first.resultsToken)).total, 0);
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

    await context.test('answer changes replace the score without adding responses', async () => {
      assert.deepEqual(await vote(first.questionToken, browser, 1), { recorded: true, score: 1 });
      assert.deepEqual(await vote(first.questionToken, browser, 5), { recorded: true, score: 5 });
      assert.equal((await question(first.questionToken)).score, 5);
      let summary = validateResults(await results(first.resultsToken));
      assert.equal(summary.total, 1);
      assert.equal(summary.average, 5);
      assert.deepEqual(summary.distribution.map(item => item.count), [0, 0, 0, 0, 1]);
      assert.deepEqual(await vote(first.questionToken, browser, 5), { recorded: true, score: 5 });
      assert.equal((await results(first.resultsToken)).total, 1);
      assert.deepEqual(await vote(first.questionToken, browser, 1), { recorded: true, score: 1 });
      assert.equal((await question(first.questionToken)).score, 1);
      assert.deepEqual(await vote(first.questionToken, randomUUID(), 2), { recorded: true, score: 2 });
      assert.deepEqual(await vote(first.questionToken, randomUUID(), 5), { recorded: true, score: 5 });
      summary = validateResults(await results(first.resultsToken));
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
      await assert.rejects(choose(multiple.questionToken, browser, ['Cowork']), { code: '42501' });
      await db.exec('reset role; set role anon');
    });

    await context.test('definition changes reset only affected responses and schema reruns preserve both types', async () => {
      await db.exec('reset role');
      await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
      await db.exec(seedSql(questions));
      await db.exec('set role anon');
      assert.equal((await results(first.resultsToken)).total, 3);
      assert.equal((await results(multiple.resultsToken)).total, 2);
      await db.exec('reset role');
      const revised = { ...multiple, options: ['Cowork', 'Agents', 'New option'] };
      await db.exec(seedSql([first, second, revised]));
      await db.exec('set role anon');
      assert.equal((await results(multiple.resultsToken)).total, 0);
      assert.equal((await results(first.resultsToken)).total, 3);
      await assert.rejects(choose(multiple.questionToken, browser, ['Both, sometimes']), { code: '22023' });
      await db.exec('reset role');
      await db.exec(seedSql([first, second, { ...revised, kind: 'rating', options: [] }]));
      await db.exec('set role anon');
      await vote(multiple.questionToken, browser, 4);
      assert.equal((await results(multiple.resultsToken)).average, 4);
      await db.exec('reset role');
      await db.exec(seedSql([first, second, multiple]));
      await db.exec('set role anon');
      assert.equal((await results(multiple.resultsToken)).total, 0);
      await choose(multiple.questionToken, browser, ['Cowork']);
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
      await assert.rejects(choose(multiple.questionToken, browser, ['Cowork']), { code: 'P0002' });
    });

    await context.test('upgrading the original rating-only tables preserves existing answers and URLs', async () => {
      const db = new PGlite();
      try {
        await db.exec(`create role anon; create role authenticated;
          create schema survey_private;
          create table survey_private.questions (
            question_token uuid primary key, results_hash text not null unique,
            prompt text not null, ordinal integer not null, enabled boolean not null default true,
            created_at timestamptz not null default now());
          create table survey_private.responses (
            question_token uuid references survey_private.questions, voter_hash text not null,
            score smallint not null check (score between 1 and 5),
            created_at timestamptz not null default now(), primary key(question_token, voter_hash));`);
        const [question] = reconcileQuestions(['Original rating']);
        const browser = randomUUID();
        const hash = value => createHash('sha256').update(value).digest('hex');
        await db.query('insert into survey_private.questions (question_token,results_hash,prompt,ordinal) values ($1,$2,$3,1)',
          [question.questionToken, hash(question.resultsToken), question.prompt]);
        await db.query('insert into survey_private.responses (question_token,voter_hash,score) values ($1,$2,4)',
          [question.questionToken, hash(`${question.questionToken}:${browser}`)]);
        const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
        await db.exec(schema);
        await db.exec(schema);
        await db.exec('set role anon');
        const { rows } = await db.query('select public.cowork_question($1,$2) as question, public.cowork_results($3) as results',
          [question.questionToken, browser, question.resultsToken]);
        assert.equal(rows[0].question.score, 4);
        assert.equal(rows[0].question.kind, 'rating');
        assert.equal(validateResults(rows[0].results).average, 4);
        assert.equal(rows[0].results.total, 1);
      } finally {
        await db.close();
      }
    });
  } finally {
    await db.close();
  }
});
