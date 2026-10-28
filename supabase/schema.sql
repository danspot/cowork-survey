begin;

create schema if not exists survey_private;
revoke all on schema survey_private from public, anon, authenticated;

create or replace function survey_private.valid_options(values_to_check text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select values_to_check is not null and
    (pg_catalog.cardinality(values_to_check) = 0 or (
      pg_catalog.array_ndims(values_to_check) = 1
      and not exists (
        select 1 from pg_catalog.unnest(values_to_check) as item(value)
        where value is null or value <> trim(value) or length(value) not between 1 and 2000
      )
      and pg_catalog.cardinality(values_to_check) =
        (select count(distinct value) from pg_catalog.unnest(values_to_check) as item(value))
    ));
$$;

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

alter table survey_private.questions add column if not exists kind text not null default 'rating';
alter table survey_private.questions add column if not exists options text[] not null default '{}';
alter table survey_private.questions drop constraint if exists questions_definition_check;
alter table survey_private.questions add constraint questions_definition_check check (
  (kind = 'rating' and options = '{}'::text[]) or
  (kind = 'multiple_choice' and pg_catalog.cardinality(options) >= 2 and survey_private.valid_options(options))
);
alter table survey_private.responses alter column score drop not null;
alter table survey_private.responses add column if not exists selections text[] not null default '{}';
alter table survey_private.responses drop constraint if exists responses_answer_check;
alter table survey_private.responses add constraint responses_answer_check check (
  (score is not null and pg_catalog.cardinality(selections) = 0) or
  (score is null and pg_catalog.cardinality(selections) > 0 and survey_private.valid_options(selections))
);

create or replace function survey_private.reset_changed_answers()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.kind is distinct from new.kind or old.options is distinct from new.options then
    delete from survey_private.responses where question_token = old.question_token;
  end if;
  return new;
end;
$$;

drop trigger if exists reset_changed_answers on survey_private.questions;
create trigger reset_changed_answers before update of kind, options on survey_private.questions
  for each row execute function survey_private.reset_changed_answers();

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
  selected survey_private.questions%rowtype;
  existing_score smallint;
  existing_selections text[];
begin
  if p_question_token is null or p_browser_token is null then
    raise exception 'Question and browser tokens are required.' using errcode = '22023';
  end if;
  select * into selected from survey_private.questions
    where question_token = p_question_token and enabled for share;
  if not found then
    raise exception 'Question not found.' using errcode = 'P0002';
  end if;
  select score, selections into existing_score, existing_selections from survey_private.responses
    where question_token = p_question_token
      and voter_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        p_question_token::text || ':' || p_browser_token::text, 'UTF8')), 'hex');
  return pg_catalog.jsonb_build_object(
    'prompt', selected.prompt, 'kind', selected.kind, 'options', selected.options,
    'score', existing_score, 'selections', coalesce(existing_selections, '{}'::text[]), 'editable', true);
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
  question_kind text;
begin
  if p_question_token is null or p_browser_token is null or p_score is null or p_score not between 1 and 5 then
    raise exception 'A valid question, browser token, and score from 1 to 5 are required.' using errcode = '22023';
  end if;
  -- The shared lock lets votes proceed together but prevents closing a question mid-vote.
  select kind into question_kind from survey_private.questions
    where question_token = p_question_token and enabled for share;
  if not found then
    raise exception 'Question not found.' using errcode = 'P0002';
  end if;
  if question_kind <> 'rating' then
    raise exception 'This question requires option selections, not a rating.' using errcode = '22023';
  end if;
  identity_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    p_question_token::text || ':' || p_browser_token::text, 'UTF8')), 'hex');
  insert into survey_private.responses (question_token, voter_hash, score)
    values (p_question_token, identity_hash, p_score)
    on conflict (question_token, voter_hash) do update set score = excluded.score, selections = '{}'
    returning score into saved_score;
  return pg_catalog.jsonb_build_object('score', saved_score, 'recorded', true);
end;
$$;

create or replace function public.cowork_choose(p_question_token uuid, p_browser_token uuid, p_selections text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected survey_private.questions%rowtype;
  identity_hash text;
  saved_selections text[];
begin
  if p_question_token is null or p_browser_token is null or p_selections is null
    or pg_catalog.cardinality(p_selections) = 0 or not survey_private.valid_options(p_selections) then
    raise exception 'Question and browser tokens and one or more distinct options are required.' using errcode = '22023';
  end if;
  select * into selected from survey_private.questions
    where question_token = p_question_token and enabled for share;
  if not found then
    raise exception 'Question not found.' using errcode = 'P0002';
  end if;
  if selected.kind <> 'multiple_choice' or not p_selections <@ selected.options then
    raise exception 'Select only options belonging to this multiple-choice question.' using errcode = '22023';
  end if;
  select pg_catalog.array_agg(value order by ordinal) into saved_selections
    from pg_catalog.unnest(selected.options) with ordinality as item(value, ordinal)
    where value = any(p_selections);
  identity_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    p_question_token::text || ':' || p_browser_token::text, 'UTF8')), 'hex');
  insert into survey_private.responses (question_token, voter_hash, score, selections)
    values (p_question_token, identity_hash, null, saved_selections)
    on conflict (question_token, voter_hash) do update set score = null, selections = excluded.selections;
  return pg_catalog.jsonb_build_object('kind', 'multiple_choice', 'selections', saved_selections, 'recorded', true);
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
  question_kind text;
  question_options text[];
  result jsonb;
begin
  if p_results_token is null then
    raise exception 'A results token is required.' using errcode = '22023';
  end if;
  select question_token, prompt, kind, options into selected_question, question_text, question_kind, question_options
    from survey_private.questions
    where results_hash = pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(p_results_token::text, 'UTF8')), 'hex')
      and enabled for share;
  if not found then
    raise exception 'Results not found.' using errcode = 'P0002';
  end if;
  if question_kind = 'multiple_choice' then
    select pg_catalog.jsonb_build_object(
      'prompt', question_text, 'kind', question_kind, 'options', question_options,
      'total', (select count(*) from survey_private.responses where question_token = selected_question),
      'average', null,
      'distribution', pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('option', value, 'count', amount) order by ordinal),
      'updatedAt', pg_catalog.now()
    ) into result from (
      select choices.value, choices.ordinal, count(responses.voter_hash) as amount
      from pg_catalog.unnest(question_options) with ordinality as choices(value, ordinal)
      left join survey_private.responses responses
        on responses.question_token = selected_question and choices.value = any(responses.selections)
      group by choices.value, choices.ordinal
    ) as buckets;
    return result;
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
    'kind', question_kind,
    'options', question_options,
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
revoke all on function public.cowork_choose(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on all functions in schema survey_private from public, anon, authenticated;
grant execute on function public.cowork_question(uuid, uuid) to anon;
grant execute on function public.cowork_vote(uuid, uuid, integer) to anon;
grant execute on function public.cowork_results(uuid) to anon;
grant execute on function public.cowork_choose(uuid, uuid, text[]) to anon;

notify pgrst, 'reload schema';

commit;
