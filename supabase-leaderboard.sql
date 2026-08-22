-- ============================================================
--  WordSwap — leaderboard migration
--
--  RUN THE TWO STEPS AS SEPARATE QUERIES.
--  The Supabase SQL editor runs a whole script in one transaction,
--  so one failing statement rolls back everything before it. Step 1
--  is what the app needs; step 2 is only cleanup. Keeping them apart
--  means a problem in the cleanup cannot undo the columns.
--
--  Every id comparison is cast to text so it works whether the
--  columns are uuid or text — that mismatch is what rolled back the
--  first attempt.
-- ============================================================


-- ============================================================
--  STEP 1 — columns, indexes, trigger.  Run this on its own.
-- ============================================================

alter table public.profiles
  add column if not exists registered   boolean not null default false,
  add column if not exists rank_points  bigint  not null default 0,
  add column if not exists freezes      int     not null default 1,
  add column if not exists country      text;

-- Anyone already signed up with a real identity belongs on the boards.
update public.profiles p
set registered = not coalesce(u.is_anonymous, false)
from auth.users u
where u.id::text = p.id::text;

-- The global board sorts by rank_points; the local board filters by
-- country first, so that index needs country leading.
create index if not exists profiles_rank_idx
  on public.profiles (rank_points desc) where registered;

create index if not exists profiles_country_rank_idx
  on public.profiles (country, rank_points desc) where registered;

create index if not exists daily_scores_day_score_idx
  on public.daily_scores (day, score desc);

-- Let the database decide who counts as registered, not the client:
-- a client can be edited, this cannot.
create or replace function public.enforce_registered()
returns trigger language plpgsql security definer as $$
begin
  select not coalesce(u.is_anonymous, false) into new.registered
  from auth.users u where u.id::text = new.id::text;
  new.registered := coalesce(new.registered, false);
  return new;
end $$;

drop trigger if exists profiles_registered on public.profiles;
create trigger profiles_registered
  before insert or update on public.profiles
  for each row execute function public.enforce_registered();


-- ============================================================
--  STEP 2 — cleanup.  Run separately, AFTER step 1 succeeds.
--  Anonymous accounts are created silently for every visitor, so
--  they pile onto the boards with 0 scores.
-- ============================================================

-- 2a. Look at what would go, first. Run this alone and read it.
select ds.day, ds.score, p.username, ds.user_id
from public.daily_scores ds
join auth.users u on u.id::text = ds.user_id::text
left join public.profiles p on p.id::text = ds.user_id::text
where u.is_anonymous
order by ds.day desc, ds.score desc;

-- 2b. If that list looks right, remove those scores.
delete from public.daily_scores ds
using auth.users u
where ds.user_id::text = u.id::text and u.is_anonymous;

-- 2c. And their profile rows. Guests keep playing fine — their
--     progress lives on the device and is pushed once they register.
delete from public.profiles p
using auth.users u
where p.id::text = u.id::text and u.is_anonymous;
