// Редирект старых расшаренных ссылок на страницы сайта.
//
// Раньше функция отдавала HTML с OG-тегами, но шлюз Supabase теперь
// принудительно отдаёт HTML-ответы функций как text/plain с CSP-sandbox
// (защита от фишинга на *.supabase.co) — в браузере показывался голый код.
// Кнопка «Поделиться» теперь даёт прямую ссылку на album.html, а эта функция
// осталась только чтобы уже разосланные старые ссылки не были битыми.
//
// Маршруты:
//   GET /og/a/<album_id>        — 302 на album.html
//   GET /og/a/<album_id>/i      — 302 на подписанную R2-ссылку обложки
//   GET /og/u/<username>        — 302 на profile.html
//   GET /og/u/<username>/i      — 302 на аватар (публичный URL) или брендовую картинку
//
// verify_jwt=false и БЕЗ apikey-гейта: по старым ссылкам приходят без заголовков.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const R2_ENDPOINT = Deno.env.get('R2_ENDPOINT')!;
const R2_BUCKET = Deno.env.get('R2_BUCKET')!;

const SITE = 'https://albums.ink';
const FALLBACK_IMG = `${SITE}/og-cover.png`;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const r2 = new AwsClient({
  accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID')!,
  secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY')!,
  service: 's3', region: 'auto',
});

const TYPE = { a: 'album', u: 'user' } as const;

async function signGet(key: string): Promise<string> {
  const u = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
  u.searchParams.set('X-Amz-Expires', '900');
  const s = await r2.sign(u.toString(), { method: 'GET', aws: { signQuery: true } });
  return s.url.toString();
}

function redirect(url: string, cache = 'public, max-age=60') {
  return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': cache } });
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

  if (!isImg) {
    const target = type === 'album'
      ? `${SITE}/album.html?id=${encodeURIComponent(key)}`
      : `${SITE}/profile.html?u=${encodeURIComponent(key)}`;
    return redirect(target, 'public, max-age=300');
  }

  // ── картинка (могла закэшироваться в старых превью мессенджеров) ──
  try {
    const { data } = await sb.rpc('og_card', { p_type: type, p_key: key });
    const card = (data && typeof data === 'object') ? data as Record<string, unknown> : null;
    if (card) {
      const cover = card.cover as string | undefined;
      if (cover && cover.startsWith('r2/')) return redirect(await signGet(cover), 'public, max-age=600');
      const avatar = card.avatar as string | undefined;   // аватар — уже публичный URL
      if (avatar) return redirect(avatar, 'public, max-age=600');
    }
  } catch { /* упадём в брендовую картинку */ }
  return redirect(FALLBACK_IMG, 'public, max-age=600');
});
