// Модерация. Пароль модератора живёт ТОЛЬКО в переменных окружения этой функции
// (MOD_LOGIN, MOD_PASSWORD) — не в репозитории и не в клиенте. Функция сама
// проверяет вход и все действия выполняет service-ключом (RLS не действует),
// поэтому клиенту не нужно и нельзя иметь доступ к таблицам модерации.
//
// Вход: POST { action: 'login', login, password } -> { token } (живёт 2 часа).
// Дальше каждый запрос несёт заголовок X-Mod-Token, функция сверяет его с
// mod_sessions и вызывает соответствующую definer-функцию.
//
// verify_jwt = false: это НЕ пользовательская авторизация Supabase, у модератора
// своя. Защита — пароль + rate-limit по хэшу IP + короткий срок токена.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MOD_LOGIN = Deno.env.get('MOD_LOGIN') ?? '';
const MOD_PASSWORD = Deno.env.get('MOD_PASSWORD') ?? '';

const ALLOW_ORIGINS = [
  'https://albums.ink',
  'https://www.albums.ink',
  'https://vgametikok.github.io',
  'http://localhost:5085',
];

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// R2: подпись просмотра для медиа, уехавшего в Cloudflare R2 (префикс пути r2/).
const R2_ENDPOINT = Deno.env.get('R2_ENDPOINT') ?? '';
const R2_BUCKET = Deno.env.get('R2_BUCKET') ?? '';
const r2 = new AwsClient({
  accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID') ?? '',
  secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY') ?? '',
  service: 's3',
  region: 'auto',
});

function cors(origin: string | null) {
  const allow = origin && ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    // apikey и authorization обязательны: клиент шлёт publishable-ключ, и без них
    // браузер валит предполётную проверку CORS — запрос не уходит вообще.
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-mod-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Хэш IP — чтобы считать неудачные попытки, не храня сам адрес.
async function ipHash(req: Request): Promise<string> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  return (await sha256hex(ip + '|albums-mod')).slice(0, 32);
}

// Постоянное по времени сравнение — чтобы по времени ответа нельзя было подобрать пароль.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const headers = cors(origin);
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method' }), { status: 405, headers });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'bad_json' }), { status: 400, headers }); }
  const action = String(body.action ?? '');

  // ---- вход ----
  if (action === 'login') {
    const iph = await ipHash(req);
    // Считаем ТОЛЬКО неудачные попытки за 15 минут — успешный вход счётчик не растит,
    // иначе честный модератор со временем заблокирует сам себя. Порог проверяем
    // до сверки пароля: если уже наспамили — не даём даже пытаться.
    const { data: preFails } = await sb.rpc('mod_recent_fails', { p_ip: iph });
    if (Number(preFails) >= 8) {
      return new Response(JSON.stringify({ error: 'too_many' }), { status: 429, headers });
    }
    const login = String(body.login ?? '');
    const password = String(body.password ?? '');
    const ok = MOD_PASSWORD.length > 0 && safeEqual(login, MOD_LOGIN) && safeEqual(password, MOD_PASSWORD);
    if (!ok) {
      await sb.rpc('mod_note_attempt', { p_ip: iph, p_ok: false });
      return new Response(JSON.stringify({ error: 'bad_credentials' }), { status: 401, headers });
    }

    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    await sb.rpc('mod_session_create', { p_hash: await sha256hex(token), p_login: MOD_LOGIN, p_ip: iph });
    return new Response(JSON.stringify({ token }), { headers });
  }

  // ---- всё остальное требует валидного токена ----
  const token = req.headers.get('x-mod-token') ?? '';
  const { data: login } = await sb.rpc('mod_session_check', { p_hash: await sha256hex(token) });
  if (!login) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers });

  try {
    let out: unknown;
    switch (action) {
      case 'queue':
        out = (await sb.rpc('mod_queue', { p_limit: body.limit ?? 50, p_offset: body.offset ?? 0 })).data;
        break;
      case 'open':
        out = (await sb.rpc('mod_open_subject', {
          p_type: body.subject_type, p_id: body.subject_id, p_login: login,
        })).data;
        break;
      case 'sign': {
        // подписанные URL для медиа спорного альбома — под service-ключом.
        // Медиа в двух бэкендах: старое — Supabase Storage, новое (r2/) — R2.
        const paths = (body.paths ?? []) as string[];
        const legacy = paths.filter((p) => !p.startsWith('r2/'));
        const r2paths = paths.filter((p) => p.startsWith('r2/'));
        const signed: { path: string; signedUrl: string }[] = [];
        if (legacy.length) {
          const { data } = await sb.storage.from('media').createSignedUrls(legacy, 600);
          (data ?? []).forEach((d) => { if (d.signedUrl) signed.push({ path: d.path, signedUrl: d.signedUrl }); });
        }
        for (const p of r2paths) {
          const u = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${p}`);
          u.searchParams.set('X-Amz-Expires', '600');
          const s = await r2.sign(u.toString(), { method: 'GET', aws: { signQuery: true } });
          signed.push({ path: p, signedUrl: s.url.toString() });
        }
        out = signed;
        break;
      }
      case 'hide':
        out = (await sb.rpc('mod_hide', {
          p_type: body.subject_type, p_id: body.subject_id, p_hide: body.hide,
          p_login: login, p_reason: body.reason ?? null,
        })).data;
        break;
      case 'ban':
        out = (await sb.rpc('mod_ban', {
          p_user: body.user_id, p_ban: body.ban, p_login: login, p_reason: body.reason ?? null,
        })).data;
        break;
      case 'stats':
        out = (await sb.rpc('admin_stats', { p_days: body.days ?? 30 })).data;
        break;
      case 'set_plan':
        out = (await sb.rpc('admin_set_plan', {
          p_username: body.username, p_plan: body.plan, p_days: body.plan_days ?? 30,
        })).data;
        break;
      case 'resolve':
        out = (await sb.rpc('mod_resolve', {
          p_report: body.report_id, p_status: body.status, p_login: login, p_note: body.note ?? null,
        })).data;
        break;
      default:
        return new Response(JSON.stringify({ error: 'unknown_action' }), { status: 400, headers });
    }
    return new Response(JSON.stringify({ data: out }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
  }
});
