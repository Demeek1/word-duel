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

  // Paste your Render server URL here after deploying (e.g. https://wordswap-server.onrender.com)
  GAME_SERVER_URL: ''
};
