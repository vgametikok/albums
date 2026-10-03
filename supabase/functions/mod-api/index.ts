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

// Допустимые формы ключей: новый R2 (как в r2-sign) и старый Supabase Storage
// (<uid>/<файл>). Всё остальное к подписи не принимается.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const R2_PATH_RE = new RegExp(`^r2/${UUID}/${UUID}/(orig|thumb)\\.[a-z0-9]{2,5}$`);
const LEGACY_PATH_RE = new RegExp(`^${UUID}/[A-Za-z0-9._-]{1,120}$`);

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

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
// Окно дат: from/to — ISO-строки (to — не включительно); по умолчанию 30 дней.
function range(body: Record<string, unknown>): { from: string; to: string } {
  const ok = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
  const to = ok(body.to) ? new Date(body.to as string) : new Date(Date.now() + 60_000);
  const days = clampInt(body.days, 1, 365, 30);
  const from = ok(body.from) ? new Date(body.from as string) : new Date(to.getTime() - days * 86400_000);
  return { from: from.toISOString(), to: to.toISOString() };
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
        //
        // Подписываем только те пути, которые реально числятся за какой-то
        // строкой media: иначе сессия модератора превращается в подпись любого
        // ключа хранилища, а «..» внутри ключа ещё и уводит подпись из бакета.
        const asked = [...new Set(((body.paths ?? []) as unknown[]).map(String))]
          .filter((p) => R2_PATH_RE.test(p) || LEGACY_PATH_RE.test(p))
          .slice(0, 240);
        if (asked.length === 0) { out = []; break; }
        const real = new Set<string>();
        for (const col of ['storage_path', 'thumb_path'] as const) {
          const { data } = await sb.from('media').select('storage_path, thumb_path').in(col, asked);
          for (const r of (data ?? []) as { storage_path: string | null; thumb_path: string | null }[]) {
            if (r.storage_path) real.add(r.storage_path);
            if (r.thumb_path) real.add(r.thumb_path);
          }
        }
        const paths = asked.filter((p) => real.has(p));
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
      case 'open_album':
        out = (await sb.rpc('mod_open_album', { p_id: body.album_id, p_login: login })).data;
        break;
      case 'pending':
        out = {
          albums: (await sb.rpc('mod_pending_albums', { p_limit: body.limit ?? 50, p_offset: body.offset ?? 0 })).data,
          count: (await sb.rpc('mod_pending_count')).data,
        };
        break;
      case 'review':
        out = (await sb.rpc('mod_review_album', {
          p_album: body.album_id, p_approve: !!body.approve, p_login: login, p_note: body.note ?? null,
        })).data;
        break;
      case 'media_pending':
        // новые файлы, долитые в чужие альбомы (гости общих альбомов и соавторы)
        out = {
          items: (await sb.rpc('mod_media_pending', { p_limit: body.limit ?? 60, p_offset: body.offset ?? 0 })).data,
          count: (await sb.rpc('mod_media_count')).data,
        };
        break;
      case 'media_review':
        out = (await sb.rpc('mod_media_review', {
          p_am_id: body.am_id, p_approve: !!body.approve, p_login: login,
        })).data;
        break;
      case 'stats':
        out = (await sb.rpc('admin_stats', { p_days: body.days ?? 30 })).data;
        break;
      case 'users':
        // Список людей с фильтрами. Почта уходит только сюда: наружу её не
        // отдаёт ни одна пользовательская RPC.
        out = (await sb.rpc('admin_users', {
          p_plan: body.plan ?? null,
          p_country: body.country ?? null,
          p_q: body.q ?? null,
          p_limit: body.limit ?? 50,
          p_offset: body.offset ?? 0,
        })).data;
        break;
      case 'recent_signups': {
        // Последние регистрации (новые сверху) за окно [from, to). Почта и способ
        // входа — из auth.users через admin API: наружу их не отдаёт ни одна RPC.
        // Гостевые (анонимные) сессии помечаются guest=true, клиент их скрывает.
        const { from, to } = range(body);
        const limit = clampInt(body.limit, 1, 50, 25);
        const offset = clampInt(body.offset, 0, 100000, 0);
        const q = await sb.from('profiles')
          .select('id,username,display_name,avatar_url,country,plan,created_at,banned_at,deleted_at', { count: 'exact' })
          .gte('created_at', from).lt('created_at', to)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);
        if (q.error) throw q.error;
        const rows = await Promise.all((q.data ?? []).map(async (p) => {
          let email: string | null = null, provider: string | null = null, guest = false, last: string | null = null;
          try {
            const { data } = await sb.auth.admin.getUserById(p.id);
            const u = data?.user;
            if (u) {
              email = u.email ?? null;
              guest = !!(u as { is_anonymous?: boolean }).is_anonymous;
              const am = (u.app_metadata ?? {}) as { provider?: string; providers?: string[] };
              provider = guest ? 'anonymous' : (am.providers?.length ? am.providers.join(', ') : am.provider ?? null);
              last = u.last_sign_in_at ?? null;
            }
          } catch { /* пользователь мог быть удалён — оставляем пустым */ }
          return { ...p, email, provider, guest, last_sign_in_at: last };
        }));
        // сколько альбомов у каждого (одним запросом на страницу)
        const cnt = new Map<string, number>();
        if (rows.length) {
          const r = await sb.from('albums').select('author_id').in('author_id', rows.map((x) => x.id));
          for (const a of r.data ?? []) cnt.set(a.author_id, (cnt.get(a.author_id) ?? 0) + 1);
        }
        rows.forEach((x) => { (x as Record<string, unknown>).albums_count = cnt.get(x.id) ?? 0; });
        out = { rows, total: q.count ?? rows.length, offset, limit };
        break;
      }
      case 'recent_albums': {
        // Альбомы, куда загружали файлы за окно [from, to): последние загрузки
        // (media.created_at) → album_media → альбомы. Без SQL, через service key.
        const { from, to } = range(body);
        const MAX = 3000;
        const media: { id: string; created_at: string }[] = [];
        for (let off = 0; off < MAX; off += 1000) {
          const r = await sb.from('media').select('id,created_at')
            .gte('created_at', from).lt('created_at', to)
            .order('created_at', { ascending: false }).range(off, off + 999);
          if (r.error) throw r.error;
          media.push(...(r.data ?? []));
          if ((r.data ?? []).length < 1000) break;
        }
        const when = new Map(media.map((m) => [m.id, m.created_at]));
        const agg = new Map<string, { n: number; last: string }>();
        for (let i = 0; i < media.length; i += 150) {
          const ids = media.slice(i, i + 150).map((m) => m.id);
          const r = await sb.from('album_media').select('album_id,media_id').in('media_id', ids);
          if (r.error) throw r.error;
          for (const am of r.data ?? []) {
            const t = when.get(am.media_id) ?? '';
            const a = agg.get(am.album_id) ?? { n: 0, last: '' };
            a.n++; if (t > a.last) a.last = t;
            agg.set(am.album_id, a);
          }
        }
        const ids = [...agg.keys()];
        const albums: Record<string, unknown>[] = [];
        for (let i = 0; i < ids.length; i += 150) {
          const r = await sb.from('albums')
            .select('id,title,author_id,is_event,event_tier,visibility,published_at,created_at,photos_count,videos_count,audio_count')
            .in('id', ids.slice(i, i + 150));
          if (r.error) throw r.error;
          albums.push(...(r.data ?? []));
        }
        const authors = [...new Set(albums.map((a) => a.author_id as string))];
        const prof = new Map<string, { username: string; display_name: string | null }>();
        for (let i = 0; i < authors.length; i += 150) {
          const r = await sb.from('profiles').select('id,username,display_name').in('id', authors.slice(i, i + 150));
          if (r.error) throw r.error;
          for (const p of r.data ?? []) prof.set(p.id, p);
        }
        const all = albums.map((a) => {
          const g = agg.get(a.id as string)!;
          const o = prof.get(a.author_id as string);
          return {
            ...a, uploads: g.n, last_upload_at: g.last,
            files: Number(a.photos_count ?? 0) + Number(a.videos_count ?? 0) + Number(a.audio_count ?? 0),
            owner: o?.username ?? null, owner_name: o?.display_name ?? null,
          };
        }).sort((x, y) => (x.last_upload_at < y.last_upload_at ? 1 : -1));
        const limit = clampInt(body.limit, 1, 100, 25);
        const offset = clampInt(body.offset, 0, 100000, 0);
        out = { rows: all.slice(offset, offset + limit), total: all.length, offset, limit, truncated: media.length >= MAX };
        break;
      }
      case 'set_plan':
        out = (await sb.rpc('admin_set_plan', {
          p_username: body.username, p_plan: body.plan, p_days: body.plan_days ?? 30,
        })).data;
        break;
      case 'grant_event':
        // общие альбомы события выдаются штуками; отрицательное число — забрать
        // tier ('medium' | 'large') — только с миграцией 054; без tier вызов
        // прежний, двухаргументный, и работает на любой версии базы.
        out = (await sb.rpc('admin_grant_event', {
          p_username: body.username, p_count: Number(body.count ?? 1),
          ...(body.tier ? { p_tier: String(body.tier) } : {}),
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
