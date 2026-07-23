// Вход через Яндекс ID.
//
// Supabase не знает Яндекс среди своих провайдеров, поэтому обмен кодами делаем
// сами. Но сессию НЕ выписываем сами: собственный JWT — это ошибка, которую
// потом невозможно отозвать. Вместо этого сервисным ключом просим Supabase
// выдать одноразовый токен входа для нужного пользователя, и клиент меняет его
// на настоящую сессию через verifyOtp. Всё управление сессиями остаётся у
// Supabase.
//
// Два маршрута:
//   GET /yandex-auth/start?redirect_to=...  — уводит на страницу согласия Яндекса
//   GET /yandex-auth/callback?code=&state=  — принимает ответ и возвращает человека
//
// verify_jwt = false: сюда приходит НЕзалогиненный человек, JWT у него ещё нет.
//
// Секреты (задаются в панели Supabase, в репозиторий не попадают):
//   YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CLIENT_ID = Deno.env.get('YANDEX_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('YANDEX_CLIENT_SECRET') ?? '';

// Куда разрешено возвращать человека. Список закрытый: адрес возврата несёт
// одноразовый токен входа, и открытый редирект отсюда означал бы угон аккаунта.
const ALLOW_ORIGINS = [
  'https://albums.ink',
  'https://www.albums.ink',
  'https://vgametikok.github.io',
  'http://localhost:5085',
];

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/yandex-auth/callback`;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function safeRedirect(raw: string | null): string {
  if (!raw) return ALLOW_ORIGINS[0];
  try {
    const u = new URL(raw);
    if (!ALLOW_ORIGINS.includes(u.origin)) return ALLOW_ORIGINS[0];
    // хвост адреса выбрасываем: возвращаем на ту же страницу, но без чужих
    // параметров и без старого фрагмента
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

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.split('/').pop();

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return new Response('yandex auth is not configured', { status: 503 });
  }

  // ---------------------------------------------------------------- start
  if (route === 'start') {
    const back = safeRedirect(url.searchParams.get('redirect_to'));
    const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

    await sb.rpc('oauth_states_sweep');
    const { error } = await sb.from('oauth_states')
      .insert({ state, provider: 'yandex', redirect_to: back });
    if (error) return fail(back, 'state');

    const auth = new URL('https://oauth.yandex.ru/authorize');
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', CLIENT_ID);
    auth.searchParams.set('redirect_uri', REDIRECT_URI);
    auth.searchParams.set('state', state);
    auth.searchParams.set('scope', 'login:email login:info login:avatar');
    // Всегда показываем выбор аккаунта: у людей в Яндексе их часто несколько,
    // и молчаливый вход не тем аккаунтом потом не объяснить.
    auth.searchParams.set('force_confirm', 'yes');
    return go(auth.toString());
  }

  // ---------------------------------------------------------------- callback
  if (route === 'callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') ?? '';

    const { data: row } = await sb.from('oauth_states')
      .select('redirect_to, created_at').eq('state', state).eq('provider', 'yandex').maybeSingle();
    const back = safeRedirect(row?.redirect_to ?? null);
    if (!row) return fail(back, 'state');

    // состояние одноразовое
    await sb.from('oauth_states').delete().eq('state', state);
    if (Date.now() - new Date(row.created_at).getTime() > 15 * 60 * 1000) return fail(back, 'expired');
    if (url.searchParams.get('error')) return fail(back, 'denied');
    if (!code) return fail(back, 'nocode');

    try {
      // 1. код -> токен
      const tokenResp = await fetch('https://oauth.yandex.ru/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }),
      });
      if (!tokenResp.ok) return fail(back, 'token');
      const { access_token } = await tokenResp.json();
      if (!access_token) return fail(back, 'token');

      // 2. токен -> кто это
      const infoResp = await fetch('https://login.yandex.ru/info?format=json', {
        headers: { Authorization: `OAuth ${access_token}` },
      });
      if (!infoResp.ok) return fail(back, 'info');
      const info = await infoResp.json();

      const externalId = String(info.id ?? '');
      const email = String(info.default_email ?? '').trim().toLowerCase();
      if (!externalId) return fail(back, 'info');
      // Без почты аккаунт не завести: она наш общий ключ между способами входа.
      if (!email) return fail(back, 'noemail');

      const name = String(info.real_name || info.display_name || info.login || '').trim();
      const avatar = info.default_avatar_id && !info.is_avatar_empty
        ? `https://avatars.yandex.net/get-yapic/${info.default_avatar_id}/islands-200`
        : null;

      // 3. находим своего пользователя: сначала по связке с Яндексом (она
      //    переживает смену почты), потом по самой почте
      let userId: string | null = null;
      let userEmail = email;

      const { data: link } = await sb.from('external_identities')
        .select('user_id').eq('provider', 'yandex').eq('external_id', externalId).maybeSingle();

      if (link?.user_id) {
        const { data: u } = await sb.auth.admin.getUserById(link.user_id);
        if (u?.user) { userId = u.user.id; userEmail = u.user.email ?? email; }
      }

      if (!userId) {
        const created = await sb.auth.admin.createUser({
          email,
          email_confirm: true,          // почту подтвердил Яндекс
          user_metadata: { full_name: name || undefined, avatar_url: avatar || undefined },
        });
        if (created.data?.user) {
          userId = created.data.user.id;
        } else {
          // Уже есть аккаунт с этой почтой — заведён через Google или по коду.
          // Это ожидаемо и правильно: один человек, одна почта, один аккаунт.
          const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
          const found = list?.users?.find((u) => (u.email ?? '').toLowerCase() === email);
          if (!found) return fail(back, 'nouser');
          userId = found.id;
        }
      }

      await sb.from('external_identities').upsert({
        provider: 'yandex', external_id: externalId, user_id: userId, email: userEmail,
      });

      // 4. просим Supabase выдать одноразовый токен входа для этого человека
      const linkResp = await sb.auth.admin.generateLink({ type: 'magiclink', email: userEmail });
      const hashed = linkResp.data?.properties?.hashed_token;
      if (!hashed) return fail(back, 'link');

      // Токен уезжает во фрагменте адреса: фрагмент не уходит на сервер и не
      // попадает ни в логи, ни в заголовок Referer.
      return go(`${back}#yandex_token=${encodeURIComponent(hashed)}`);
    } catch (_) {
      return fail(back, 'failed');
    }
  }

  return new Response('not found', { status: 404 });
});
