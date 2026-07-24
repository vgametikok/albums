// Вход через Telegram (Login Widget), redirect-режим.
//
// Виджет уводит человека на страницу Telegram, тот подтверждает вход, и Telegram
// редиректит браузер СЮДА с подписанными полями профиля в query. Проверяем
// подпись (HMAC по токену бота), находим/заводим пользователя и, как в
// yandex-auth, свой JWT НЕ выписываем: сервисным ключом просим Supabase выдать
// одноразовый токен входа, а клиент меняет его на сессию через verifyOtp.
//
// Redirect-режим выбран намеренно вместо data-onauth: колбэк виджета исполняется
// через eval, а у нас CSP без 'unsafe-eval'. Редирект обходится без него.
//
// Telegram не отдаёт ни почту, ни телефон — только id, имя, @username, аватар.
// Аккаунт держим на синтетическом адресе <username|tgID>@telegram.local: ник
// профиля строится из части до «@» (см. ensure_profile), почта туда не шлётся.
//
// verify_jwt = false: сюда приходит незалогиненный человек.
// Секрет (панель Supabase): TELEGRAM_BOT_TOKEN.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';

// Куда разрешено возвращать человека. Список закрытый: адрес возврата несёт
// одноразовый токен входа, открытый редирект отсюда = угон аккаунта.
const ALLOW_ORIGINS = [
  'https://albums.ink',
  'https://www.albums.ink',
  'https://vgametikok.github.io',
  'http://localhost:5085',
];

// Ровно те поля, которые подписывает Telegram. Всё остальное в query (наш
// return) в проверку подписи НЕ входит.
const TG_FIELDS = ['auth_date', 'first_name', 'id', 'last_name', 'photo_url', 'username'];

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function safeRedirect(raw: string | null): string {
  if (!raw) return ALLOW_ORIGINS[0];
  try {
    const u = new URL(raw);
    if (!ALLOW_ORIGINS.includes(u.origin)) return ALLOW_ORIGINS[0];
    return u.origin + u.pathname + u.search;
  } catch {
    return ALLOW_ORIGINS[0];
  }
}

function go(url: string) {
  return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' } });
}

function fail(back: string, reason: string) {
  const sep = back.includes('#') ? '&' : '#';
  return go(`${back}${sep}auth_error=${encodeURIComponent(reason)}`);
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// data-check-string: key=value по подписанным полям, сортировка по ключу, \n.
// secret = SHA256(bot_token), hash = HMAC-SHA256(dcs, secret).
async function validSignature(p: URLSearchParams): Promise<boolean> {
  const enc = new TextEncoder();
  const pairs: string[] = [];
  for (const k of TG_FIELDS) {
    const v = p.get(k);
    if (v !== null) pairs.push(`${k}=${v}`);
  }
  const dcs = pairs.sort().join('\n');
  const secret = await crypto.subtle.digest('SHA-256', enc.encode(BOT_TOKEN));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(dcs));
  const want = (p.get('hash') ?? '').toLowerCase();
  const got = hex(sig).toLowerCase();
  // сравнение постоянного времени
  if (want.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.split('/').pop();

  if (!BOT_TOKEN) return new Response('telegram auth is not configured', { status: 503 });
  if (route !== 'callback') return new Response('not found', { status: 404 });

  const p = url.searchParams;
  const back = safeRedirect(p.get('return'));

  const tgId = p.get('id') ?? '';
  if (!tgId || !p.get('hash') || !p.get('auth_date')) return fail(back, 'bad');
  if (!(await validSignature(p))) return fail(back, 'signature');
  // Не старше суток — защита от повторной отправки старого подписанного payload.
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return fail(back, 'expired');

  try {
    const username = (p.get('username') ?? '').replace(/[^a-zA-Z0-9_]/g, '');
    const name = [p.get('first_name'), p.get('last_name')].filter(Boolean).join(' ').trim();
    const avatar = p.get('photo_url') || null;
    const email = (username ? username.toLowerCase() : `tg${tgId}`) + '@telegram.local';

    // 1. существующий пользователь по связке telegram → user (переживает смену
    //    @username и почты)
    let userId: string | null = null;
    let userEmail = email;
    const { data: link } = await sb.from('external_identities')
      .select('user_id').eq('provider', 'telegram').eq('external_id', tgId).maybeSingle();
    if (link?.user_id) {
      const { data: u } = await sb.auth.admin.getUserById(link.user_id);
      if (u?.user) { userId = u.user.id; userEmail = u.user.email ?? email; }
    }

    // 2. по почте — тот же человек, входивший другим способом (или прошлый
    //    вход, ещё не связанный). Проверяем ДО создания: createUser на гонке
    //    репликации мог отдать пустого user при фактически созданной записи.
    if (!userId) {
      const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
      const found = list?.users?.find((u) => (u.email ?? '').toLowerCase() === email);
      if (found) { userId = found.id; userEmail = found.email ?? email; }
    }

    // 3. иначе заводим
    if (!userId) {
      const created = await sb.auth.admin.createUser({
        email,
        email_confirm: true,           // «подтверждение» дал сам Telegram
        user_metadata: {
          full_name: name || undefined,
          avatar_url: avatar || undefined,
          telegram_username: username || undefined,
        },
      });
      if (created.error || !created.data?.user) return fail(back, 'create');
      userId = created.data.user.id;
    }

    await sb.from('external_identities').upsert({
      provider: 'telegram', external_id: tgId, user_id: userId, email: userEmail,
    });

    // 3. одноразовый токен входа — его клиент меняет на сессию
    const linkResp = await sb.auth.admin.generateLink({ type: 'magiclink', email: userEmail });
    const hashed = linkResp.data?.properties?.hashed_token;
    if (!hashed) return fail(back, 'link');

    // Токен уезжает во фрагменте: он не уходит на серверы и не попадает в Referer.
    return go(`${back}#tg_token=${encodeURIComponent(hashed)}`);
  } catch (_) {
    return fail(back, 'failed');
  }
});
