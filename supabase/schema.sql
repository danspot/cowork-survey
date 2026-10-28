begin;

create schema if not exists survey_private;
revoke all on schema survey_private from public, anon, authenticated;

create table if not exists survey_private.questions (
  question_token uuid primary key,
  results_hash text not null unique check (length(results_hash) = 64),
  prompt text not null check (length(trim(prompt)) between 1 and 2000),
  ordinal integer not null check (ordinal > 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists survey_private.responses (
  question_token uuid not null references survey_private.questions(question_token),
  voter_hash text not null check (length(voter_hash) = 64),
  score smallint not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (question_token, voter_hash)
);

alter table survey_private.questions enable row level security;
alter table survey_private.responses enable row level security;
revoke all on all tables in schema survey_private from public, anon, authenticated;

create or replace function public.cowork_question(p_question_token uuid, p_browser_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  question_text text;
  existing_score smallint;
begin
  if p_question_token is null or p_browser_token is null then
    raise exception 'Question and browser tokens are required.' using errcode = '22023';
  end if;
  select prompt into question_text from survey_private.questions
    where question_token = p_question_token and enabled;
  if not found then
    raise exception 'Question not found.' using errcode = 'P0002';
  end if;
  select score into existing_score from survey_private.responses
    where question_token = p_question_token
      and voter_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        p_question_token::text || ':' || p_browser_token::text, 'UTF8')), 'hex');
  return pg_catalog.jsonb_build_object('prompt', question_text, 'score', existing_score);
end;
$$;

create or replace function public.cowork_vote(p_question_token uuid, p_browser_token uuid, p_score integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  identity_hash text;
  saved_score smallint;
  inserted_count integer;
begin
  if p_question_token is null or p_browser_token is null or p_score is null or p_score not between 1 and 5 then
    raise exception 'A valid question, browser token, and score from 1 to 5 are required.' using errcode = '22023';
  end if;
  -- The shared lock lets votes proceed together but prevents closing a question mid-vote.
  perform 1 from survey_private.questions
    where question_token = p_question_token and enabled for share;
  if not found then
    raise exception 'Question not found.' using errcode = 'P0002';
  end if;
  identity_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    p_question_token::text || ':' || p_browser_token::text, 'UTF8')), 'hex');
  insert into survey_private.responses (question_token, voter_hash, score)
    values (p_question_token, identity_hash, p_score)
    on conflict (question_token, voter_hash) do nothing;
  get diagnostics inserted_count = row_count;
  select score into saved_score from survey_private.responses
    where question_token = p_question_token and voter_hash = identity_hash;
  return pg_catalog.jsonb_build_object('score', saved_score, 'recorded', inserted_count = 1);
end;
$$;

create or replace function public.cowork_results(p_results_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_question uuid;
  question_text text;
  result jsonb;
begin
  if p_results_token is null then
    raise exception 'A results token is required.' using errcode = '22023';
  end if;
  select question_token, prompt into selected_question, question_text
    from survey_private.questions
    where results_hash = pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(p_results_token::text, 'UTF8')), 'hex')
      and enabled;
  if not found then
    raise exception 'Results not found.' using errcode = 'P0002';
  end if;
  -- Derive the total, average, and buckets from one snapshot during live voting.
  with buckets as (
    select choices.score, count(responses.score)::integer as amount
    from pg_catalog.generate_series(1, 5) as choices(score)
    left join survey_private.responses responses
      on responses.question_token = selected_question and responses.score = choices.score
    group by choices.score
  )
  select pg_catalog.jsonb_build_object(
    'prompt', question_text,
    'total', sum(amount),
    'average', case when sum(amount) > 0 then sum(score * amount)::numeric / sum(amount) else null end,
    'distribution', pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('score', score, 'count', amount) order by score),
    'updatedAt', pg_catalog.now()
  ) into result from buckets;
  return result;
end;
$$;

revoke all on function public.cowork_question(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cowork_vote(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.cowork_results(uuid) from public, anon, authenticated;
grant execute on function public.cowork_question(uuid, uuid) to anon;
grant execute on function public.cowork_vote(uuid, uuid, integer) to anon;
grant execute on function public.cowork_results(uuid) to anon;

commit;
