-- ============================================================
--  WordSwap — Milestone 2, Step 1: persistent push subscriptions
--  Paste into Supabase → SQL Editor → New query → Run.
--  Only the server (service role) touches this table, so RLS is
--  ON with no public policies = nobody but the server can read/write.
-- ============================================================

create table if not exists public.push_subscriptions (
  user_id      text primary key,
  subscription jsonb not null,
  updated_at   timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
-- (no policies added on purpose: the server uses the service_role key,
--  which bypasses RLS; the public anon key can neither read nor write.)
