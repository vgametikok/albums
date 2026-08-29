// Supabase-клиент, авторизация (Google и почта) и профиль текущего пользователя.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

/**
 * Запрос, который не висит вечно.
 *
 * Без этого зависший (а не отклонённый) запрос к API оставлял страницу
 * бесконечно пустой: шапка и подвал рисуются локально, а всё, что ждёт
 * данных, просто не наступало — и человек видел пустой экран без единого
 * объяснения. Так это выглядело у пользователей, чей провайдер не пропускал
 * запросы к домену API.
 *
 * Загрузку файлов в хранилище не трогаем: большое видео честно заливается
 * дольше любого разумного таймаута.
 */
const REQUEST_TIMEOUT_MS = 20000;

function timedFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url || '';
  const isUpload = /\/storage\/v1\/object\//.test(url)
    && ['POST', 'PUT'].includes(String(init.method || 'GET').toUpperCase());
  if (isUpload || init.signal) return fetch(input, init);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  global: { fetch: timedFetch },
});

/**
 * Похоже ли на «до сервера не достучались», а не «сервер ответил отказом».
 * Нужно, чтобы не врать человеку про испорченную ссылку, когда на деле
 * не открывается соединение.
 */
export function isNetworkError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return !err?.code && (m.includes('failed to fetch') || m.includes('networkerror')
    || m.includes('load failed') || m.includes('aborted') || m.includes('abort'));
}

let _session = null;
let _me = null;
let _ready = null;

/** Поднимает сессию и (для залогиненных) провижинит строку profiles. */
export function ready() {
  if (!_ready) _ready = init();
  return _ready;
}

async function init() {
  await finishExternalAuth();
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
/** Гостевая (анонимная) сессия: человек загружает без регистрации. */
export function isGuest() { return !!_session?.user?.is_anonymous; }

/**
 * Вход «без регистрации»: Supabase создаёт анонимного пользователя. Для базы
 * это обычный authenticated — работают RLS, квоты и rate-limit'ы. Профиль
 * (user123) заведёт ensure_profile при следующем ready(), поэтому после
 * успеха страницу нужно перезагрузить.
 */
export async function signInAnonymously() {
  const { error } = await sb.auth.signInAnonymously();
  if (error) throw error;
}

export async function signIn() {
  const redirectTo = location.origin + location.pathname + location.search;
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, queryParams: { prompt: 'select_account' } },
  });
  if (error) throw error;
}

/* ---------------- Яндекс ID (пока скрыт из UI, плюмбинг живой) ---------------- */

const YANDEX_START = `${SUPABASE_URL}/functions/v1/yandex-auth/start`;

/** Уводит на страницу согласия Яндекса. Возврат обрабатывает finishExternalAuth. */
export function signInYandex() {
  const back = location.origin + location.pathname + location.search;
  location.href = `${YANDEX_START}?redirect_to=${encodeURIComponent(back)}`;
}

/* ---------------- Telegram ---------------- */

/** База адреса возврата для виджета Telegram (redirect-режим). */
export const TG_CALLBACK = `${SUPABASE_URL}/functions/v1/tg-auth/callback`;

/**
 * Возврат от внешнего провайдера (Яндекс, Telegram). Их функции кладут
 * одноразовый токен во фрагмент адреса — туда, куда браузер не пускает ни
 * серверы, ни заголовок Referer. Меняем его на настоящую сессию и сразу
 * вычищаем из адресной строки, чтобы токен не остался в истории и не уехал
 * с копипастом ссылки.
 */
let _authError = null;
async function finishExternalAuth() {
  if (!location.hash) return;
  const h = new URLSearchParams(location.hash.slice(1));
  const token = h.get('tg_token') || h.get('yandex_token');
  const err = h.get('auth_error');
  if (!token && !err) return;

  h.delete('tg_token');
  h.delete('yandex_token');
  h.delete('auth_error');
  const rest = h.toString();
  history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));

  if (err) { _authError = err; return; }
  const { error } = await sb.auth.verifyOtp({ token_hash: token, type: 'magiclink' });
  if (error) _authError = 'verify';
}

/** Забирает код ошибки внешнего входа, если он был (одноразово). */
export function takeAuthError() {
  const e = _authError;
  _authError = null;
  return e;
}

export async function signOut() {
  await sb.auth.signOut();
  location.reload();
}
