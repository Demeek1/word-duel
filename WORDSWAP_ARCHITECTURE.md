# WordSwap — Production Architecture & Roadmap

*A build blueprint for the full competitive platform, grounded in the stack we're already running (Supabase + Render + PWA→native). Sections map 1:1 to your "Deliver 1–7" list. ✅ = already live, 🔨 = designed/next, 🧭 = future.*

---

## 0. Reality check & recommended stack

**What's already live today**
- ✅ Accounts: Email/password, **Google**, Guest (anonymous) — Supabase Auth
- ✅ Cloud profiles + global/daily leaderboards (Postgres + RLS)
- ✅ Real-time 1v1 online matches — **server-authoritative** timers + word validation (anti-cheat baseline) on a Node/Socket.IO server (Render)
- ✅ Solo vs AI (4 difficulties), local pass-&-play, premium mobile UI (PWA, installable, offline)
- ✅ Web-push notifications (free, no store account) + admin broadcast
- ✅ Progression: XP, levels, coins, streak, achievements, cosmetic shop/themes

**Recommended stack (keeps cost near-zero until scale, then grows cleanly)**

| Layer | Choice | Why |
|---|---|---|
| Auth | **Supabase Auth** | Email/Google done; **Apple** = one provider toggle; JWT, refresh, 2FA (TOTP) built-in |
| DB | **Supabase Postgres** | RLS = per-row security; SQL migrations; scales to managed Postgres |
| Realtime | **Node + Socket.IO on Render** (→ Fly.io/Railway at scale) | Server-authoritative match engine; horizontal scale via Redis adapter later |
| Cache/matchmaking | **Redis** (Upstash free tier) | Matchmaking queue, presence, rate limiting, socket scaling |
| Push | **Web Push (VAPID)** now → **FCM/APNs** in the native wrap | Free to test now; native at launch |
| Native apps | **Capacitor** wrap of the PWA | One codebase → App Store + Play Store; native IAP + push |
| Admin | **Next.js dashboard** (Vercel) talking to Supabase + an admin API | API-first; RBAC via Supabase roles |
| Analytics | **PostHog** (self-host/free tier) + Postgres event table → warehouse (BigQuery) later | Funnels, cohorts, flags, A/B out of the box |
| IAP validation | **RevenueCat** (free < $2.5k/mo) | Handles Apple/Google receipt validation + subscriptions |

---

## 1. Backend architecture & database schema

**Service topology (modular, API-first)**
```
Mobile (Capacitor/iOS/Android) ─┐
Web PWA ────────────────────────┼─► Supabase Auth (JWT)
Admin (Next.js) ────────────────┘        │
                                          ▼
   ┌──────────────── API Gateway (REST + versioned /v1) ─────────────────┐
   │  Auth svc │ Profile svc │ Economy svc │ Match svc │ Admin svc │ …    │
   └───────────────────────────┬───────────────────────────┬────────────┘
        Postgres (Supabase)     │        Realtime (Socket.IO + Redis)     │
        Redis (queue/presence)  │        Push (Web/FCM/APNs)              │
        PostHog / warehouse ◄───┴── event bus ──────────────────────────┘
```

**Core schema (Postgres). ✅ tables exist; others are the build list.**

```sql
-- ✅ profiles (extend)
profiles(id uuid pk→auth.users, username citext unique, avatar, country, language,
  level int, xp int, coins int, gems int, rating int default 1000, rd int default 350,
  wins int, losses int, streak int, best_chain int, created_at, is_banned bool,
  ban_until timestamptz, flags jsonb)

-- matches (server-authoritative record)
matches(id uuid pk, mode text, -- quick|ranked|private|async|tournament
  status text, -- lobby|active|complete|abandoned
  language text, len int, dictionary_id uuid,
  start_word text, winner_id uuid, loss_reason text, -- timeout|no_move|resign|disconnect
  created_at, ended_at, ranked bool, tournament_id uuid, cheat_flag text)
match_players(match_id, user_id, seat int, score int, rating_before int, rating_after int,
  connected bool, primary key(match_id,user_id))
match_moves(id bigserial pk, match_id, user_id, seq int, word text, ms_remaining int,
  valid bool, created_at)               -- full replay + anti-cheat source of truth

-- dictionaries (multi-language, admin-editable, no app update)
dictionaries(id uuid pk, language, name, is_default bool, updated_at)
dictionary_words(dictionary_id, word, primary key(dictionary_id,word))
banned_words(language, word, primary key(language,word))
word_overrides(dictionary_id, word, allow bool)   -- admin allow/deny

-- economy (immutable ledger)
coin_ledger(id bigserial pk, user_id, delta int, balance_after int, reason text,
  ref_type text, ref_id text, created_at)          -- append-only, auditable
purchases(id uuid pk, user_id, platform text, product_id, price_cents, currency,
  store_txn_id text unique, status text, validated_at, refunded_at)
subscriptions(user_id, product_id, status, renews_at, platform, store_txn_id)
inventory(user_id, item_id, acquired_at, primary key(user_id,item_id))
catalog(item_id pk, kind text, price_coins int, price_cents int, cosmetic bool)  -- cosmetic-only

-- competitive
seasons(id, name, starts_at, ends_at, ruleset jsonb)
leagues(id, season_id, tier text, division int)
league_members(season_id, user_id, points int, rank int, promoted bool)
leaderboards(scope text, period text, user_id, value int, rank int)  -- materialized/refreshed
tournaments(id, name, format text, status, starts_at, prize jsonb, created_by)
tournament_entrants(tournament_id, user_id, seed int, eliminated_at)

-- social / safety
friends(user_id, friend_id, status text, primary key(user_id,friend_id))
blocks(user_id, blocked_id, primary key(user_id,blocked_id))
reports(id, reporter_id, target_id, kind text, context jsonb, status, created_at)
devices(id, user_id, platform, fingerprint_hash, last_seen, risk_score)
push_subscriptions(user_id pk, subscription jsonb, updated_at)   -- ✅ (Milestone 2)

-- ops
audit_log(id bigserial pk, actor_id, action, target_type, target_id, before jsonb,
  after jsonb, ip inet, created_at)                 -- every admin/financial/ban/reward action
feature_flags(key pk, enabled bool, rollout int, variants jsonb, audience jsonb)
events(id bigserial, user_id, name text, props jsonb, ts)  -- analytics fan-out
```

**Design principles baked in:** server is the only source of truth for timers/words/scores/rewards; the coin ledger is **append-only** (balance is a projection, never edited); every mutation an admin/finance action writes to `audit_log`; all money/rank/ban logic lives server-side.

---

## 2. Admin dashboard — screens & permissions

**RBAC roles** (enforced by Supabase JWT claim `role` + row policies, checked again in the admin API):

| Role | Can do |
|---|---|
| **Super Admin** | Everything, incl. role management + feature flags + finance |
| **Game Admin** | Rules, timers, dictionaries, events, tournaments, reward configs |
| **Support** | Player lookup, account recovery, refunds (request), support notes |
| **Content Manager** | Dictionaries, banners, announcements, quests, catalog (cosmetics) |
| **Moderator** | Moderation queue, mute/ban/shadow-ban, report handling |
| **Analyst** | Read-only analytics + exports (no PII beyond policy) |
| **Finance** | Purchases, refunds, ledger, fraud, payouts, revenue reports |

**Screens**
1. **Overview** — DAU/WAU/MAU, concurrent players, new accounts, D1/D7/D30 retention, revenue, match-completion rate, crash rate, live alerts.
2. **Player search** (username/email/user-ID/device-ID/txn-ID) → **Player profile**: status, devices, reports, match history + replays, purchases, rank history, moderation history, support notes.
3. **Moderation queue** — reported usernames/chat/cheating/abuse, one-click actions.
4. **Actions panel** (each writes `audit_log`): suspend, ban, shadow-ban, mute, restrict chat, reset profile, restore, grant/remove rewards, force logout.
5. **Live-ops / Content** — dictionaries & banned words, timer/rule config, reward values, level curves, events, banners, announcements, quests, **feature flags** — all **without an app update**.
6. **Tournaments** — create/seed/run brackets, prizes.
7. **Support tools** — refunds, purchase verification, account recovery, issue tracker.
8. **Reports & export** — CSV export, warehouse connector.

---

## 3. Secure API specification (versioned `/v1`, JWT bearer)

**Auth**: Supabase JWT; short-lived access token + rotating refresh; every endpoint validates the token server-side and re-checks role/ownership. Rate-limited per IP + per user (Redis).

**REST (representative)**
```
POST /v1/auth/link            # merge guest → full account
GET  /v1/me                   # profile
PATCH/v1/me                   # username(moderated)/avatar/privacy
GET  /v1/leaderboards?scope=&period=
POST /v1/matches/quick        # enter matchmaking (casual/ranked)
POST /v1/matches/private      # create room → code+link
POST /v1/matches/:id/move     # server validates (authoritative); async matches
GET  /v1/matches/:id/replay
POST /v1/economy/purchase/validate   # RevenueCat/Apple/Google receipt
GET  /v1/economy/ledger
POST /v1/reports  POST /v1/blocks  POST /v1/friends
# Admin (role-gated): /v1/admin/players, /players/:id/actions, /dictionaries,
#   /flags, /tournaments, /economy/refund, /analytics/*, /audit
```

**WebSocket (live matches)** — server-authoritative events:
`create · join · start · move(→validate) · state · moved · opp_status(typing/thinking) · react · gameover · rematch` plus `matchmaking:enqueue/found`, presence, and reconnect with a grace window. (✅ most of this is running today.)

**Every score/timer/word/reward decision happens server-side.** The client only renders and requests.

---

## 4. Analytics event plan

**Event taxonomy** (`snake_case`, sent to PostHog + `events` table):
```
install, app_open, signup_start, signup_complete(method), onboarding_step(n),
first_match_start, match_start(mode), move_made(valid, ms_left), word_rejected(reason),
match_end(result, reason, duration, chain_len), first_win, first_loss, match_abandon,
daily_challenge_play, streak_extend(day), share_result,
store_view, purchase_start, purchase_complete(product, price), subscription_start,
reward_grant(source, amount), rank_change(delta, tier), report_submit, block_user,
notif_permission(granted), notif_open(kind), return_visit, churn_flag
```

**Funnels**: install→account · account→first match · first→second match · free→paying.
**Cohorts/retention**: D1/D7/D30 + custom, segmented by country, platform, app version, acquisition channel, language, skill tier, cohort.
**Health metrics**: DAU/WAU/MAU, session length, games/player, avg match duration, word-validation failures, timeout losses, disconnect rate, win rates, rank distribution, bot usage.
**Economy**: coins earned/spent by source, purchase conversion, ARPDAU, ARPU, LTV, refunds, fraud signals.
**A/B + flags**: onboarding, timers, matchmaking, rewards, prices, ads, new modes — all flag-gated.
**Automated alerts**: retention drop, login-failure spike, cheat-report spike, crash spike, payment errors, server latency.

---

## 5. Anti-cheat & fraud strategy

**Principle: never trust the client** for scoring, timers, word validation, purchases, rankings, or rewards — all server-authoritative (✅ already true for live matches).

- **Move integrity** (server): exactly-one-letter change, same length, real dictionary word, no repeats, correct turn, and **server clock** owns the countdown (client time ignored).
- **Behavioral signals** → `risk_score`: impossible reaction times / speed hacks, abnormal win rates, repeated identical word patterns, match-fixing (two accounts trading wins), account farming, multi-accounting via device fingerprint, emulator/VPN abuse.
- **Detection pipeline**: every move stored in `match_moves` → offline jobs flag anomalies → `cheat_flag` on match + moderation queue. Shadow-ban suspicious players into a segregated pool.
- **Purchase/economy fraud**: server-side receipt validation (RevenueCat), refund-abuse tracking, referral/promo-code fraud limits, reward-grant rate caps, immutable ledger for audit.
- **Platform**: rate limiting, brute-force lockout, CAPTCHA on suspicious auth, device fingerprint + risk scoring (privacy-compliant), full `audit_log`.

---

## 6. Player account & privacy flows

- **Sign-in**: Email/pass (✅), Google (✅), **Apple** (toggle — required by Apple if you offer other social logins), Guest (✅).
- **Guest → account linking**: keep the same `user_id`; Supabase `linkIdentity` merges the guest into the new credential so progress carries over. (Design ready.)
- **Account safety**: email verification, password reset, strength rules, session/device management, **logout-all-devices**, optional **TOTP 2FA**.
- **Moderation & control**: username moderation, report/block, privacy settings, **account deletion** (right to erasure) + **data export** (right to access).
- **Child safety / compliance**: age gate, parental-consent flow where required, child-safe defaults, clear privacy controls; **GDPR/CCPA/COPPA** readiness — consent tracking, privacy-policy surface, data-retention + deletion jobs, PII minimization in analytics.

---

## 7. Phased roadmap

### Phase A — Launch essentials (get to the stores) 🔨 *next 2–4 build cycles*
1. **Persistent push subscriptions** (✅ just built) + **async matches** + "your turn" pings.
2. **Apple Sign In** (toggle) + **guest→account linking**.
3. **Matchmaking** (quick-play queue via Redis) + **Elo/Glicko rating** + ranked flag.
4. **Native wrap (Capacitor)** → App Store + Play Store; native push + **IAP via RevenueCat** (cosmetics + ad-free subscription).
5. **Coin ledger + cosmetic catalog** (server-authoritative).
6. **Lite admin** (Next.js): player search, ban/mute, dictionary + banned-words editor, broadcast, audit log, feature flags.
7. **Core analytics** (PostHog) + retention/funnel dashboards + alerts.
8. **Compliance surface**: privacy policy, account deletion + export, age gate.

### Phase B — Post-launch growth 🧭
Seasons/leagues/divisions + promotion/relegation, daily challenge + quests + battle-pass-ready progression, friends/social, tournaments, referral/creator codes, richer moderation queue, A/B testing, warehouse export, deeper anti-cheat jobs.

### Phase C — Advanced future 🧭
Clans, voice/chat moderation, esports/tournament ops, AI-powered recommendations & matchmaking, multi-language dictionaries at scale, web gameplay, LiveOps event engine, multi-region low-latency + Redis-scaled realtime, disaster recovery + replication + uptime SLOs.

---

## Honest cost & sequencing notes
- **Everything in Phase A runs on free/cheap tiers** except the two store accounts (**Google $25 once, Apple $99/yr**) and, past ~a few thousand DAU, paid Render/Redis/Postgres (tens of $/mo).
- **Do not build the full enterprise admin/analytics/anti-cheat up front** — ship Phase A, get real players, then let actual usage tell us which of B/C to build. Building it all before launch is the #1 way indie games die.
- We execute this **in order**, one shippable slice at a time — exactly how we've been going.
```
```
