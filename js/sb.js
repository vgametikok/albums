// Supabase-клиент, авторизация (Google и почта) и профиль текущего пользователя.
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

/**
 * Вход по почте. Supabase шлёт одно письмо, в котором в зависимости от шаблона
 * либо ссылка, либо код — мы поддерживаем оба конца: по ссылке сессию подхватит
 * detectSessionInUrl при загрузке страницы, код проверяем сами в verifyEmailCode.
 *
 * shouldCreateUser: незнакомая почта заводит нового пользователя — это и есть
 * регистрация. Отдельной формы «зарегистрироваться» нет намеренно: лишний шаг
 * без единой новой крупицы данных.
 */
export async function signInByEmail(email) {
  const redirectTo = location.origin + location.pathname + location.search;
  const { error } = await sb.auth.signInWithOtp({
    email: String(email).trim(),
    options: { shouldCreateUser: true, emailRedirectTo: redirectTo },
  });
  if (error) throw error;
}

/**
 * Проверка кода из письма. Тип токена зависит от того, новый это человек или
 * знакомый, и Supabase про это не сообщает заранее — поэтому перебираем все
 * три, пока один не подойдёт. Ошибку показываем от последней попытки.
 */
export async function verifyEmailCode(email, code) {
  const token = String(code).replace(/\s+/g, '');
  let last = null;
  for (const type of ['email', 'magiclink', 'signup']) {
    const { data, error } = await sb.auth.verifyOtp({ email: String(email).trim(), token, type });
    if (!error) return data;
    last = error;
  }
  throw last || new Error('bad code');
}

export async function signOut() {
  await sb.auth.signOut();
  location.reload();
}
