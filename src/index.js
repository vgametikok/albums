/**
 * Превью ссылок в мессенджерах (Open Graph).
 *
 * Страницы сайта — статические: название альбома и обложку подставляет JS уже
 * в браузере. Краулер мессенджера скрипты не исполняет и видит только теги из
 * album.html, поэтому в Telegram показывалась одна и та же заглушка.
 *
 * Здесь запрос краулера перехватывается и ему отдаётся маленькая HTML-страница
 * с настоящими og-тегами. Человек проходит мимо: ему отдаётся обычная статика
 * через биндинг ASSETS.
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

// Кто именно приходит за превью. Список закрытый: обычный посетитель должен
// получать настоящую страницу, а не эту заглушку для роботов.
//
// ВАЖНО: только краулеры мессенджеров и соцсетей. Поисковых ботов
// (Googlebot, bingbot, YandexBot, Applebot, DuckDuckBot) здесь быть НЕ должно:
// заглушка уходит с X-Robots-Tag: noindex, и поисковик, получивший её,
// выкидывает страницу из индекса. Поисковики должны видеть обычную статику.
const CRAWLER = /(TelegramBot|WhatsApp|twitterbot|facebookexternalhit|facebookcatalog|Discordbot|Slackbot|Slack-ImgProxy|LinkedInBot|vkShare|OdklBot|redditbot|Pinterest|SkypeUriPreview|viber|Line-ApacheHttpClient|Iframely|Embedly)/i;

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

// Маркетинговые и правовые страницы живут на чистых адресах: /pricing.
// Так они уже разосланы в sitemap и работали на GitHub Pages; html_handling
// в wrangler.jsonc выключен, поэтому сопоставление делаем сами.
// С формы с расширением (/pricing.html) — 301 на чистую: обе отдавали 200,
// а дубль без canonical размывает индекс.
// Приложенческие адреса (album.html?id=, profile.html?u=, editor.html…)
// не трогаем: они разосланы людям именно в таком виде.
const CLEAN_PAGES = new Set(['pricing', 'terms', 'privacy', 'refunds']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Всё, что не превью, отдаёт статика — код в это не вмешивается.
    // Корень отдаём вручную: переписывание адресов выключено (см. wrangler.jsonc),
    // поэтому «/» сам по себе с index.html не сопоставляется.
    const asset = () => env.ASSETS.fetch(
      url.pathname === '/' ? new Request(new URL('/index.html', url), request) : request,
    );

    const clean = url.pathname.match(/^\/([a-z-]+?)(\.html)?\/?$/);
    if (clean && CLEAN_PAGES.has(clean[1])) {
      // /pricing.html и /pricing/ → 301 /pricing; /pricing → сам файл.
      if (clean[2] || url.pathname.endsWith('/')) {
        return Response.redirect(`${SITE}/${clean[1]}${url.search}`, 301);
      }
      return env.ASSETS.fetch(new Request(new URL(`/${clean[1]}.html`, url), request));
    }

    // /event из старого sitemap → экран событий приложения. Наоборот (со
    // страницы на чистый адрес) не редиректим: event.html — приложение,
    // внутренние переходы ходят на event.html?id= и не должны ловить 301.
    if (url.pathname === '/event') {
      return Response.redirect(`${SITE}/event.html${url.search}`, 301);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return asset();
    if (!CRAWLER.test(request.headers.get('user-agent') || '')) return asset();

    if (url.pathname === '/album.html') {
      const id = url.searchParams.get('id');
      if (!id) return asset();
      const card = await ogCard('album', id);
      if (!card) return asset();          // приватный, скрытый или несуществующий
      return html(page({
        title: `${card.title || 'Album'} — ${BRAND}`,
        desc: card.desc || [card.author, contents(card)].filter(Boolean).join(' · '),
        image: `${SUPABASE_URL}/functions/v1/og/a/${encodeURIComponent(id)}/i`,
        url: `${SITE}/album.html?id=${encodeURIComponent(id)}`,
      }));
    }

    if (url.pathname === '/profile.html') {
      const u = url.searchParams.get('u');
      if (!u) return asset();
      const card = await ogCard('user', u);
      if (!card) return asset();
      const albums = Number(card.albums) || 0;
      return html(page({
        title: `${card.title || card.username} — ${BRAND}`,
        desc: card.desc || `${albums} ${albums === 1 ? 'album' : 'albums'} on ${BRAND}`,
        image: `${SUPABASE_URL}/functions/v1/og/u/${encodeURIComponent(u)}/i`,
        url: `${SITE}/profile.html?u=${encodeURIComponent(u)}`,
      }));
    }

    return asset();
  },
};

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
