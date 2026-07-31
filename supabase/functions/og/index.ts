// OG-превью для расшаренных ссылок.
//
// Сайт статический (GitHub Pages), содержимое рисует JS, а краулеры соцсетей
// JS не исполняют — ссылка на альбом показывалась голой. Эта функция отдаёт
// краулеру честные OG-теги (название, автор, обложка), а живого человека
// мгновенно перекидывает в приложение. Кнопка «Поделиться» даёт ссылку сюда.
//
// Маршруты:
//   GET /og/a/<album_id>        — HTML с OG-тегами альбома + редирект на album.html
//   GET /og/a/<album_id>/i      — 302 на подписанную R2-ссылку обложки
//   GET /og/u/<username>        — то же для профиля
//   GET /og/u/<username>/i      — 302 на аватар (публичный URL) или брендовую картинку
//
// verify_jwt=false и БЕЗ apikey-гейта: краулер приходит без заголовков. Данные
// безопасны — og_card отдаёт только публичный контент (гейт can_view_* с
// viewer=null внутри RPC), обложку подписываем только если og_card её вернул.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const R2_ENDPOINT = Deno.env.get('R2_ENDPOINT')!;
const R2_BUCKET = Deno.env.get('R2_BUCKET')!;

const SITE = 'https://albums.ink';
const FALLBACK_IMG = `${SITE}/og-cover.png`;
const FN = `${SUPABASE_URL}/functions/v1/og`;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const r2 = new AwsClient({
  accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID')!,
  secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY')!,
  service: 's3', region: 'auto',
});

const TYPE = { a: 'album', u: 'user', p: 'post' } as const;

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// OG-описание — одной строкой, без переносов, не длиннее ~200 символов.
function oneline(s: unknown, max = 200): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

async function signGet(key: string): Promise<string> {
  const u = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
  u.searchParams.set('X-Amz-Expires', '900');
  const s = await r2.sign(u.toString(), { method: 'GET', aws: { signQuery: true } });
  return s.url.toString();
}

function redirect(url: string, cache = 'public, max-age=60') {
  return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': cache } });
}

function ogHtml(o: { title: string; desc: string; image: string; url: string }) {
  const t = esc(o.title), d = esc(o.desc), img = esc(o.image), u = esc(o.url);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Albums">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${img}">
<meta property="og:url" content="${u}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${img}">
<link rel="canonical" href="${u}">
<meta http-equiv="refresh" content="0; url=${u}">
<script>location.replace(${JSON.stringify(o.url)})</script>
</head><body style="font-family:system-ui,sans-serif;background:#F5F4F0;color:#141414;text-align:center;padding:60px">
<p><a href="${u}">${t}</a></p></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // хвост после /og/
  const parts = url.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('og');
  const seg = i >= 0 ? parts.slice(i + 1) : [];
  const short = seg[0];
  const key = seg[1] ? decodeURIComponent(seg[1]) : '';
  const isImg = seg[2] === 'i';
  const type = TYPE[short as keyof typeof TYPE];

  if (!type || !key) return redirect(SITE);

  const target =
    type === 'album' ? `${SITE}/album.html?id=${encodeURIComponent(key)}`
    : type === 'user' ? `${SITE}/profile.html?u=${encodeURIComponent(key)}`
    : `${SITE}/`;

  let card: Record<string, unknown> | null = null;
  try {
    const { data } = await sb.rpc('og_card', { p_type: type, p_key: key });
    card = (data && typeof data === 'object') ? data as Record<string, unknown> : null;
  } catch { card = null; }

  // ── картинка ──
  if (isImg) {
    try {
      if (card) {
        const cover = card.cover as string | undefined;
        if (cover && cover.startsWith('r2/')) return redirect(await signGet(cover), 'public, max-age=600');
        const avatar = card.avatar as string | undefined;   // аватар — уже публичный URL
        if (avatar) return redirect(avatar, 'public, max-age=600');
      }
    } catch { /* упадём в брендовую картинку */ }
    return redirect(FALLBACK_IMG, 'public, max-age=600');
  }

  // ── HTML-карточка ──
  const img = `${FN}/${short}/${encodeURIComponent(key)}/i`;

  if (!card) {
    // приватное/несуществующее — обезличенная карточка, без утечки
    return ogHtml({
      title: 'Albums — put your life into stories',
      desc: 'Photos, videos and your own voice, told in chapters. Share your life — or keep it close.',
      image: FALLBACK_IMG, url: target,
    });
  }

  let title: string, desc: string;
  if (type === 'user') {
    title = `${card.title} · Albums`;
    const n = Number(card.albums ?? 0);
    desc = oneline(card.desc) || `${card.title} on Albums${n ? ` · ${n} album${n === 1 ? '' : 's'}` : ''}`;
  } else {
    title = String(card.title);
    const bits: string[] = [];
    const ph = Number(card.photos ?? 0), vi = Number(card.videos ?? 0), au = Number(card.audio ?? 0);
    if (ph) bits.push(`${ph} photo${ph === 1 ? '' : 's'}`);
    if (vi) bits.push(`${vi} video${vi === 1 ? '' : 's'}`);
    if (au) bits.push(`${au} voice note${au === 1 ? '' : 's'}`);
    const meta = [`by ${card.author}`, ...bits].join(' · ');
    desc = oneline(card.desc) ? `${oneline(card.desc)} — ${meta}` : `${meta} · on Albums`;
  }

  return ogHtml({ title, desc, image: card.cover || card.avatar ? img : FALLBACK_IMG, url: target });
});
