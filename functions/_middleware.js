/**
 * Превью ссылок в мессенджерах (Open Graph) для Cloudflare Pages.
 *
 * Страницы сайта — статические: название альбома и обложку подставляет JS уже
 * в браузере. Краулер мессенджера скрипты не исполняет и видит только теги из
 * album.html, поэтому в Telegram показывалась одна и та же заглушка.
 *
 * Здесь запрос краулера перехватывается и ему отдаётся маленькая HTML-страница
 * с настоящими og-тегами. Человек проходит мимо: ему отдаётся обычная статика.
 *
 * Почему не в edge-функции Supabase: её шлюз принудительно отвечает
 * text/plain + nosniff, и такую страницу не разбирает ни один краулер.
 *
 * Данные берутся из og_card — той же RPC, что и раньше. Она отдаёт карточку
 * только для того, что видно анониму, поэтому приватный альбом превью не
 * получает: в мессенджер уйдёт обычная заглушка сайта.
 */

const SUPABASE_URL = 'https://rizveurkjpcwrmbtoawj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vpoMQyLN_a1CeYBPuGIuIA_VI5x07JD';

const SITE = 'https://albums.ink';
const BRAND = 'Albums.ink';
const FALLBACK_IMG = `${SITE}/og-cover.png`;

// Кто именно приходит за превью. Список закрытый: обычный посетитель должен
// получать настоящую страницу, а не эту заглушку для роботов.
const CRAWLER = /(TelegramBot|WhatsApp|twitterbot|facebookexternalhit|facebookcatalog|Discordbot|Slackbot|Slack-ImgProxy|LinkedInBot|vkShare|OdklBot|redditbot|Pinterest|SkypeUriPreview|viber|Line-ApacheHttpClient|Googlebot|bingbot|Applebot|DuckDuckBot|YandexBot|Iframely|Embedly)/i;

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const cut = (s, n) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n - 1).trimEnd() + '…' : v;
};

/** Состав альбома словами: «5 photos · 2 videos». Нули пропускаем. */
function contents(card) {
  const parts = [];
  const add = (n, one, many) => { if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`); };
  add(Number(card.photos) || 0, 'photo', 'photos');
  add(Number(card.videos) || 0, 'video', 'videos');
  add(Number(card.audio) || 0, 'audio track', 'audio tracks');
  return parts.join(' · ');
}

async function ogCard(type, key) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/og_card`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_type: type, p_key: key }),
  });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  return data && typeof data === 'object' ? data : null;
}

function page({ title, desc, image, url }) {
  const t = esc(cut(title, 110));
  const d = esc(cut(desc, 200));
  const i = esc(image);
  const u = esc(url);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${u}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${i}">
<meta property="og:url" content="${u}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${i}">
</head>
<body><a href="${u}">${t}</a></body>
</html>`;
}

export async function onRequest(context) {
  const { request, next } = context;

  if (request.method !== 'GET' && request.method !== 'HEAD') return next();
  if (!CRAWLER.test(request.headers.get('user-agent') || '')) return next();

  const url = new URL(request.url);
  let card = null, image = FALLBACK_IMG, canonical = SITE;

  if (url.pathname === '/album.html') {
    const id = url.searchParams.get('id');
    if (!id) return next();
    card = await ogCard('album', id);
    if (!card) return next();          // приватный, скрытый или несуществующий
    image = `${SUPABASE_URL}/functions/v1/og/a/${encodeURIComponent(id)}/i`;
    canonical = `${SITE}/album.html?id=${encodeURIComponent(id)}`;
    return html(page({
      title: `${card.title || 'Album'} — ${BRAND}`,
      desc: card.desc || [card.author, contents(card)].filter(Boolean).join(' · '),
      image, url: canonical,
    }));
  }

  if (url.pathname === '/profile.html') {
    const u = url.searchParams.get('u');
    if (!u) return next();
    card = await ogCard('user', u);
    if (!card) return next();
    image = `${SUPABASE_URL}/functions/v1/og/u/${encodeURIComponent(u)}/i`;
    canonical = `${SITE}/profile.html?u=${encodeURIComponent(u)}`;
    const albums = Number(card.albums) || 0;
    return html(page({
      title: `${card.title || card.username} — ${BRAND}`,
      desc: card.desc || `${albums} ${albums === 1 ? 'album' : 'albums'} on ${BRAND}`,
      image, url: canonical,
    }));
  }

  return next();
}

function html(body) {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Мессенджеры кэшируют превью у себя; десять минут на своей стороне
      // хватает, чтобы правка названия альбома доехала без долгого ожидания.
      'Cache-Control': 'public, max-age=600',
      'X-Robots-Tag': 'noindex',
    },
  });
}
