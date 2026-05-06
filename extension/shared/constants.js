/**
 * Tania — Shared Constants
 *
 * Supabase project URL + anon key. Hardcoded so the extension installs
 * with just "Load unpacked" — no separate backend to run.
 *
 * To point this extension at your own Supabase project:
 *   1. Replace the two values below with the URL + anon key from your
 *      project (Settings → API in the Supabase dashboard).
 *   2. Run `supabase/schema.sql` in the SQL editor.
 *   3. Repackage the extension (see releases/).
 *
 * The anon key is *meant* to be public — it grants no privileges by
 * itself. All access control lives in the Row Level Security policies
 * defined in `supabase/schema.sql`. Keep your service_role key secret;
 * never paste it here.
 */

export const SUPABASE_URL      = 'https://isrgdwkykriahzgdtaqd.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlzcmdkd2t5a3JpYWh6Z2R0YXFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4OTI4NDYsImV4cCI6MjA5MzQ2ODg0Nn0.YeBo7Pt9Ej0LCsfxvluXHzmu3kX9h50ymIaYXWq8ZL4';

/**
 * Resolve config. Checks chrome.storage.local first (so devs can override
 * without editing this file), then falls back to the constants above.
 */
export async function getSupabaseConfig() {
  try {
    const data = await new Promise((resolve) =>
      chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey'], resolve)
    );
    return {
      url:     data.supabaseUrl     || SUPABASE_URL,
      anonKey: data.supabaseAnonKey || SUPABASE_ANON_KEY,
    };
  } catch {
    return { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY };
  }
}

export const MESSAGES = {
  LINK_DROPPED: 'LINK_DROPPED',
  RECEIVE_LINK: 'RECEIVE_LINK',
  GET_AUTH:     'GET_AUTH',
  SET_AUTH:     'SET_AUTH',
  CLEAR_AUTH:   'CLEAR_AUTH',
  CHECK_URL:    'CHECK_URL',
  UPDATE_BADGE: 'UPDATE_BADGE',
};
