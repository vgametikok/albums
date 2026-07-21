// r2-sign — выдача временных (presigned) ссылок к приватному R2-бакету.
// Полная версия (шаг 3, R2-PLAN.md §2). Заменяет временный /selftest.
//
// Маршруты (роутинг по хвосту пути):
//   POST /sign-view   — батч-подпись ЧТЕНИЯ. Гость или юзер. Право проверяется
//                       тем же предикатом can_view_media, что и storage-политика.
//   POST /sign-upload — подпись ЗАПИСИ. Только авторизованный. Ключ строит СЕРВЕР.
//
// verify_jwt=false (ключ проекта sb_publishable_* — НЕ JWT; шлюз завернул бы гостя).
// Аутентификация внутри: apikey-гейт (публичный ключ) + getUser(bearer). Нет юзера
// -> fail-closed viewer=null (только публичное), НИКОГДА не throw «в открытое».
//
// ДВА ИНВАРИАНТА БЕЗОПАСНОСТИ:
//   1. viewer — ТОЛЬКО из проверенного JWT, НИКОГДА из тела запроса.
//   2. media-id ВСЕГДА заново извлекается из пути; uid-сегмент пути в авторизации
//      не участвует. Это делает бессмысленной подмену storage_path при insert.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUBLISHABLE = Deno.env.get('SB_PUBLISHABLE_KEY') ?? '';
const R2_ENDPOINT = Deno.env.get('R2_ENDPOINT')!;
const R2_BUCKET = Deno.env.get('R2_BUCKET')!;
const QUOTA = Number(Deno.env.get('R2_USER_QUOTA_BYTES') ?? '524288000');

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const r2 = new AwsClient({
  accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID')!,
  secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY')!,
  service: 's3',
  region: 'auto',
});

const ALLOW_ORIGINS = ['https://albums.ink', 'https://www.albums.ink', 'https://vgametikok.github.io', 'http://localhost:5085'];
function cors(origin: string | null) {
  const allow = origin && ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}
const json = (status: number, obj: unknown, h: Record<string, string>) =>
  new Response(JSON.stringify(obj), { status, headers: h });

// ── Whitelist типов (точное равенство, никаких startsWith) ──────────────────
const TYPE_EXT: Record<string, Record<string, string>> = {
  photo: { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' },
  video: { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v' },
  audio: { 'audio/webm': 'weba', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav' },
};
const THUMB_TYPE: Record<string, string> = { 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const SIZE_LIMIT: Record<string, number> = { photo: 30 * 1048576, video: 50 * 1048576, audio: 20 * 1048576 };
const THUMB_LIMIT = 2 * 1048576;

const norm = (t: unknown) => String(t ?? '').split(';')[0].trim().toLowerCase();

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH_RE = new RegExp(`^r2/${UUID}/${UUID}/(orig|thumb)\\.[a-z0-9]{2,5}$`);
const UUID_RE = new RegExp(`^${UUID}$`);

async function ipHash(req: Request): Promise<string> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '|r2-sign'));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// Дата подписи, округлённая вниз до 10-минутного окна -> одинаковый URL для одного
// ключа внутри окна (браузерный кэш работает). Формат AMZ: YYYYMMDDTHHMMSSZ.
function windowDate(): { amz: string; exp: number } {
  const start = Math.floor(Date.now() / 1000 / 600) * 600;
  const amz = new Date(start * 1000).toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  return { amz, exp: start + 900 };
}

async function signGet(key: string, amz: string): Promise<string> {
  const u = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
  u.searchParams.set('X-Amz-Expires', '900');
  // Переопределяем Cache-Control ответа — иначе браузер кэширует эвристически (~1 мин).
  u.searchParams.set('response-cache-control', 'private, max-age=900');
  const signed = await r2.sign(u.toString(), { method: 'GET', aws: { signQuery: true, datetime: amz } });
  return signed.url.toString();
}

async function signPut(key: string, contentType: string): Promise<string> {
  const u = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
  u.searchParams.set('X-Amz-Expires', '900');
  // allHeaders:true -> Content-Type попадает в подпись (иначе aws4fetch его выкинет),
  // и R2 вернёт 403, если браузер зальёт файл с другим типом.
  const signed = await r2.sign(u.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url.toString();
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const h = cors(origin);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  if (req.method !== 'POST') return json(405, { error: 'method' }, h);

  // apikey-гейт: режет совсем мусорный трафик (ключ публичный, обычное сравнение).
  if (!PUBLISHABLE || req.headers.get('apikey') !== PUBLISHABLE) {
    return json(401, { error: 'bad_apikey' }, h);
  }

  const url = new URL(req.url);
  const route = url.pathname.split('/').pop();

  // viewer — ТОЛЬКО из JWT. Гость (bearer == публичный ключ) -> null без обращения к Auth.
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  let viewer: string | null = null;
  if (bearer && bearer !== PUBLISHABLE) {
    try { viewer = (await sb.auth.getUser(bearer)).data.user?.id ?? null; } catch { viewer = null; }
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }, h); }

  // ── /sign-view ────────────────────────────────────────────────────────────
  if (route === 'sign-view') {
    if (!(await sb.rpc('r2_rate_hit', { p_key: 'view:' + await ipHash(req), p_limit: 120, p_window_sec: 60 })).data) {
      return json(429, { error: 'rate_limited' }, h);
    }
    const raw = Array.isArray(body.paths) ? (body.paths as unknown[]) : [];
    const paths = [...new Set(raw.map(String))].filter((p) => PATH_RE.test(p)).slice(0, 240);
    if (paths.length === 0) return json(200, { urls: {}, exp: 0 }, h);

    const mediaIds = [...new Set(paths.map((p) => p.split('/')[2]))];
    const { data: allowedRaw } = await sb.rpc('r2_can_view_media_batch', { p_media: mediaIds, p_viewer: viewer });
    // setof/array — обе формы: массив строк или массив однополевых объектов.
    const allowed = new Set(
      (Array.isArray(allowedRaw) ? allowedRaw : [])
        .map((r) => (typeof r === 'string' ? r : Object.values(r as object)[0] as string)),
    );

    const { amz, exp } = windowDate();
    const urls: Record<string, string> = {};
    for (const p of paths) {
      if (allowed.has(p.split('/')[2])) urls[p] = await signGet(p, amz);
    }
    return json(200, { urls, exp }, h);
  }

  // ── /sign-upload ──────────────────────────────────────────────────────────
  if (route === 'sign-upload') {
    if (!viewer) return json(401, { error: 'auth_required' }, h);
    if (!(await sb.rpc('r2_rate_hit', { p_key: 'upload:' + viewer, p_limit: 30, p_window_sec: 60 })).data) {
      return json(429, { error: 'rate_limited' }, h);
    }

    const target = body.target === 'thumb' ? 'thumb' : 'orig';

    // Достройка постера к уже существующей строке: подписываем ТОЛЬКО thumb своей строки.
    if (target === 'thumb') {
      const mediaId = String(body.mediaId ?? '');
      if (!UUID_RE.test(mediaId)) return json(400, { error: 'bad_media_id' }, h);
      const tType = norm(body.thumbType);
      const tExt = THUMB_TYPE[tType];
      if (!tExt) return json(400, { error: 'bad_thumb_type' }, h);
      const { data: row } = await sb.from('media').select('owner_id').eq('id', mediaId).maybeSingle();
      if (!row || row.owner_id !== viewer) return json(403, { error: 'not_owner' }, h);
      const thumbPath = `r2/${viewer}/${mediaId}/thumb.${tExt}`;
      return json(200, { mediaId, thumbPath, thumbPutUrl: await signPut(thumbPath, tType), expiresIn: 900 }, h);
    }

    // Основная загрузка: оригинал (+ миниатюра, если есть).
    const kind = String(body.kind ?? '');
    const cType = norm(body.contentType);
    const ext = TYPE_EXT[kind]?.[cType];
    if (!ext) return json(400, { error: 'bad_type', kind, contentType: cType }, h);
    const size = Number(body.size ?? 0);
    if (!(size >= 0) || size > SIZE_LIMIT[kind]) return json(413, { error: 'too_large' }, h);

    let thumbExt: string | null = null, thumbType = '', thumbSize = 0;
    if (body.thumbType != null) {
      thumbType = norm(body.thumbType);
      thumbExt = THUMB_TYPE[thumbType] ?? null;
      if (!thumbExt) return json(400, { error: 'bad_thumb_type' }, h);
      thumbSize = Number(body.thumbSize ?? 0);
      if (!(thumbSize >= 0) || thumbSize > THUMB_LIMIT) return json(413, { error: 'thumb_too_large' }, h);
    }

    const mediaId = crypto.randomUUID();
    const reserve = (await sb.rpc('r2_reserve_upload', {
      p_owner: viewer, p_media: mediaId, p_size: size, p_thumb: thumbSize, p_quota: QUOTA,
    })).data as { ok: boolean; used: number; limit: number };
    if (!reserve?.ok) return json(413, { error: 'quota_exceeded', used: reserve?.used, limit: reserve?.limit }, h);

    const path = `r2/${viewer}/${mediaId}/orig.${ext}`;
    const out: Record<string, unknown> = {
      mediaId, path, putUrl: await signPut(path, cType), expiresIn: 900,
      thumbPath: null, thumbPutUrl: null,
    };
    if (thumbExt) {
      const thumbPath = `r2/${viewer}/${mediaId}/thumb.${thumbExt}`;
      out.thumbPath = thumbPath;
      out.thumbPutUrl = await signPut(thumbPath, thumbType);
    }
    return json(200, out, h);
  }

  return json(404, { error: 'not_found' }, h);
});
