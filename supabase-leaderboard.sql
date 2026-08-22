-- ============================================================
--  WordSwap — leaderboard migration
--
--  Nothing here reads auth.users. The dashboard role has no
--  permission on that table ("permission denied for table users"),
--  and an earlier version of this file depended on it twice.
--
--  RUN EACH STEP AS ITS OWN QUERY. The Supabase SQL editor runs a
--  script as one transaction, so a later failure rolls back what
--  came before. Step 1 is all the app actually needs.
-- ============================================================


-- ============================================================
--  STEP 1 — REQUIRED. Columns and indexes. Run this alone.
--  No auth schema, no triggers: this cannot hit a permission wall.
-- ============================================================

alter table public.profiles
  add column if not exists registered   boolean not null default false,
  add column if not exists rank_points  bigint  not null default 0,
  add column if not exists freezes      int     not null default 1,
  add column if not exists country      text;

create index if not exists profiles_rank_idx
  on public.profiles (rank_points desc) where registered;

create index if not exists profiles_country_rank_idx
  on public.profiles (country, rank_points desc) where registered;

create index if not exists daily_scores_day_score_idx
  on public.daily_scores (day, score desc);

-- Existing rows start at registered = false, so the boards will look
-- sparse for a moment. The app sends `registered` on every save, so a
-- real player reappears the next time they open it. Nothing is lost —
-- their rank_points and best scores are already in the row.


-- ============================================================
--  STEP 2 — OPTIONAL. Stop a modified client claiming to be
--  registered. Run separately; if it fails, skip it. Everything
--  still works, it is just the client being trusted on this one
--  field rather than the database.
-- ============================================================

-- Reads the caller's own token instead of auth.users. A client cannot
-- forge its token, so this is enforcement, not a hint.
-- Note: a write with no token at all — a dashboard edit, or the service
-- role — has no is_anonymous claim and is treated as registered.
create or replace function public.enforce_registered()
returns trigger language plpgsql security definer as $$
begin
  new.registered := not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
  return new;
end $$;

drop trigger if exists profiles_registered on public.profiles;
create trigger profiles_registered
  before insert or update on public.profiles
  for each row execute function public.enforce_registered();


-- ============================================================
--  STEP 3 — OPTIONAL, and better left for later. Physically remove
--  scores belonging to accounts that are not registered.
--
--  The boards already filter these out, so this is housekeeping, not
--  a fix. Wait until real players have opened the app again after
--  step 1 — until they do, their profile still says registered=false
--  and this would delete their scores along with the junk.
-- ============================================================

-- 3a. Look first. Run this alone and read it.
select ds.day, ds.score, p.username, p.registered
from public.daily_scores ds
left join public.profiles p on p.id::text = ds.user_id::text
where p.id is null or not p.registered
order by ds.day desc, ds.score desc;

-- 3b. Only if that list is all junk.
delete from public.daily_scores ds
where not exists (
  select 1 from public.profiles p
  where p.id::text = ds.user_id::text and p.registered
);
