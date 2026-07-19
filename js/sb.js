// Supabase-клиент, авторизация (только Google) и профиль текущего пользователя.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

let _session = null;
let _me = null;
let _ready = null;

/** Поднимает сессию и (для залогиненных) провижинит строку profiles. */
export function ready() {
  if (!_ready) _ready = init();
  return _ready;
}

async function init() {
  const { data } = await sb.auth.getSession();
  _session = data.session || null;
  if (_session) {
    try {
      const { data: prof, error } = await sb.rpc('ensure_profile');
      if (!error) _me = prof;
    } catch (_) { /* профиль подтянется при следующем входе */ }
  }
  sb.auth.onAuthStateChange((_evt, s) => { _session = s; });
  return { session: _session, me: _me };
}

export function currentUser() { return _session?.user || null; }
export function currentProfile() { return _me; }
export function isAuthed() { return !!_session; }

export async function signIn() {
  const redirectTo = location.origin + location.pathname + location.search;
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, queryParams: { prompt: 'select_account' } },
  });
  if (error) throw error;
}

export async function signOut() {
  await sb.auth.signOut();
  location.reload();
}
