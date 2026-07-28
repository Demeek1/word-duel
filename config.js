/* ============================================================
 *  WordSwap configuration.
 *
 *  SUPABASE_URL / SUPABASE_ANON_KEY  -> accounts + leaderboards (Phase 1)
 *  GAME_SERVER_URL                   -> Online Friend Match server (Phase 2)
 *
 *  The publishable key is safe to be public (browser-side);
 *  your data is protected by Row Level Security in the database.
 *  Leave any value '' to disable that feature (game still runs).
 * ============================================================ */
window.WORDSWAP_CONFIG = {
  SUPABASE_URL: 'https://sjbuxqvbzdzpkxynrlwb.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_klyQrP9jF0drWcN-1Ha_hg_9euK5JeZ',

  // Render server URL for Online Friend Match:
  GAME_SERVER_URL: 'https://wordswap-server.onrender.com',

  // Web-push public key (safe to be public). Paste the VAPID PUBLIC key here.
  VAPID_PUBLIC_KEY: 'BLRhMWoNtIdzGCzKfnSGGGjdAVeCn3oSYY2OQ0Zu7Fnim484yWwRXkvglA9GnfAy_X68f5YHvBEj-7s30xnWiY8'
};
