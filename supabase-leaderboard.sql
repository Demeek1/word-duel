-- ============================================================
--  WordSwap — leaderboard migration
--  Paste into Supabase → SQL Editor → New query → Run.
--
--  The app works without this: every new query falls back to the
--  old columns if these are missing. Running it turns on ranking
--  points, the country board, cloud-synced streak freezes, and
--  keeps anonymous device accounts off the public boards.
-- ============================================================


-- ---------- 1. Look before deleting ----------
-- Anonymous accounts are created silently for every visitor, so they
-- pile up on the boards with 0 scores. Review what would go first.

select ds.day, ds.score, p.username, ds.user_id
from public.daily_scores ds
join auth.users u on u.id = ds.user_id
left join public.profiles p on p.id = ds.user_id
where u.is_anonymous
order by ds.day desc, ds.score desc;

-- If that list looks right, remove those rows.
-- (If it errors on a type mismatch, user_id is text: use ds.user_id::uuid = u.id)

delete from public.daily_scores ds
using auth.users u
where ds.user_id = u.id and u.is_anonymous;

-- Their profile rows too. Guests keep playing fine — their progress
-- lives on the device and is pushed once they register.

delete from public.profiles p
using auth.users u
where p.id = u.id and u.is_anonymous;


-- ---------- 2. Columns ----------

alter table public.profiles
  add column if not exists registered   boolean not null default false,
  add column if not exists rank_points  bigint  not null default 0,
  add column if not exists freezes      int     not null default 1,
  add column if not exists country      text;

-- Anyone already signed up with a real identity belongs on the boards.
update public.profiles p
set registered = not coalesce(u.is_anonymous, false)
from auth.users u
where u.id = p.id;


-- ---------- 3. Indexes ----------
-- The global board sorts by rank_points; the local board filters by
-- country first, so it needs country leading.

create index if not exists profiles_rank_idx
  on public.profiles (rank_points desc)
  where registered;

create index if not exists profiles_country_rank_idx
  on public.profiles (country, rank_points desc)
  where registered;

create index if not exists daily_scores_day_score_idx
  on public.daily_scores (day, score desc);


-- ---------- 4. Keep anonymous accounts out from now on ----------
-- The client already sets registered=false for anonymous sessions, but a
-- client can be edited. This makes the database the one that decides.

create or replace function public.enforce_registered()
returns trigger language plpgsql security definer as $$
begin
  select not coalesce(u.is_anonymous, false) into new.registered
  from auth.users u where u.id = new.id;
  return new;
end $$;

drop trigger if exists profiles_registered on public.profiles;
create trigger profiles_registered
  before insert or update on public.profiles
  for each row execute function public.enforce_registered();
