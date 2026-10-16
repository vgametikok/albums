/**
 * Cloudflare Worker перед GitHub Pages (маршруты — в wrangler.toml).
 *
 * Сайт по-прежнему живёт на GitHub Pages; Worker стоит на проксированном
 * домене и для большинства запросов просто отдаёт ответ Pages (fetch(request)
 * из Worker'а на свой же хост уходит в origin, а не по кругу в Worker).
 *
 * Делает сверху три вещи:
 *  1. album.html?id= и profile.html?u= — для ВСЕХ (людей, мессенджеров и
 *     поисковиков одинаково, без клоакинга) подменяет SEO-блок <!-- seo -->
 *     на настоящие title/description/canonical/og/twitter и кладёт в
 *     <main id="app"> видимый текст (заголовок, автор, описание). SPA при
 *     загрузке делает clear(app) и рисует страницу как раньше.
 *  2. /og/a/<id>.jpg и /og/u/<name>.jpg — стабильная картинка превью на нашем
 *     домене: тянем edge-функцию og (она 302 на подписанную R2-ссылку) и
 *     отдаём байты с кэшем на сутки. Подписанная ссылка не утекает в og:image
 *     и не протухает в кэше мессенджера.
 *  3. /sitemap.xml — живой список публичных альбомов поверх статической карты.
 *
 * Приватность: данные только из RPC og_card под публикуемым (anon) ключом —
 * она отдаёт карточку лишь того, что видно анониму. Приватный, скрытый,
 * отклонённый альбом или забаненный автор → null → страница уходит как есть
 * (общая заглушка) и с noindex.
 */

const SUPABASE_URL = 'https://rizveurkjpcwrmbtoawj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vpoMQyLN_a1CeYBPuGIuIA_VI5x07JD'; // публикуемый, не секрет
const SITE = 'https://albums.ink';
const BRAND = 'Albums.ink';
const FALLBACK_IMG = `${SITE}/img/og/og-album.jpg`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME = /^[A-Za-z0-9_.-]{1,40}$/;

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const cut = (s, n) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n - 1).trimEnd() + '…' : v;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function contents(c) {
  const p = [];
  if (+c.photos > 0) p.push(plural(+c.photos, 'photo', 'photos'));
  if (+c.videos > 0) p.push(plural(+c.videos, 'video', 'videos'));
  if (+c.audio > 0) p.push(plural(+c.audio, 'audio track', 'audio tracks'));
  return p.join(' · ');
}

async function ogCard(type, key, ctx) {
  // Кэш на краю на 5 минут: краулеры любят ходить пачкой.
  const cacheKey = new Request(`${SITE}/__og_card/${type}/${encodeURIComponent(key)}`);
  const cache = caches.default;
  let r = await cache.match(cacheKey);
  if (!r) {
    r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/og_card`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_type: type, p_key: key }),
    });
    if (!r.ok) return null;
    r = new Response(await r.text(), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' } });
    ctx.waitUntil(cache.put(cacheKey, r.clone()));
  }
  const data = await r.json().catch(() => null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

function seoBlock({ title, desc, image, url, robots }) {
  const t = esc(cut(title, 110)), d = esc(cut(desc, 200)), i = esc(image), u = esc(url);
  return [
    '<!-- seo -->',
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    url ? `<link rel="canonical" href="${u}">` : '',
    robots ? `<meta name="robots" content="${robots}">` : '',
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${BRAND}">`,
    url ? `<meta property="og:url" content="${u}">` : '',
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:image" content="${i}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${t}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${i}">`,
    '<!-- /seo -->',
  ].filter(Boolean).join('\n');
}

/**
 * Подменяет блок между <!-- seo --> и <!-- /seo --> и наполняет <main id="app">.
 * Страницы маленькие (несколько КБ), поэтому проще и надёжнее заменить
 * текстом, чем ловить комментарии HTMLRewriter'ом.
 */
async function rewrite(resp, block, body) {
  let html = await resp.text();
  html = html.replace(/<!-- seo -->[\s\S]*?<!-- \/seo -->/, block);
  if (body) html = html.replace(/<main id="app">\s*<\/main>/, `<main id="app">${body}</main>`);
  const h = new Headers(resp.headers);
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.delete('Content-Length'); h.delete('ETag');
  h.set('Cache-Control', 'public, max-age=300');
  return new Response(html, { status: resp.status, headers: h });
}

async function albumPage(req, url, ctx) {
  const id = url.searchParams.get('id') || '';
  const origin = await fetch(req);
  if (!origin.ok || !UUID.test(id)) return origin;
  const c = await ogCard('album', id, ctx);
  const canonical = `${SITE}/album.html?id=${id}`;
  if (!c) {
    // Не публичный или нет такого: общая заглушка, но из индекса долой.
    return rewrite(origin, seoBlock({ title: `Album — ${BRAND}`, desc: 'A photo album on Albums.ink.', image: FALLBACK_IMG, robots: 'noindex,follow' }));
  }
  const what = contents(c);
  const desc = c.desc || [c.author && `By ${c.author}`, what].filter(Boolean).join(' · ') || 'A photo album on Albums.ink';
  const body = `<article class="ssr" style="max-width:760px;margin:32px auto;padding:0 16px">
<h1>${esc(c.title || 'Album')}</h1>
<p>${c.author ? `By <a href="/profile.html?u=${encodeURIComponent(c.author_username || '')}">${esc(c.author)}</a>` : ''}${what ? ` · ${esc(what)}` : ''}</p>
${c.desc ? `<p>${esc(c.desc)}</p>` : ''}
${c.cover ? `<p><img src="/og/a/${id}.jpg" alt="${esc(c.title || 'Album cover')}" style="max-width:100%;height:auto"></p>` : ''}
</article>`;
  return rewrite(origin, seoBlock({
    title: `${c.title || 'Album'} — ${BRAND}`, desc,
    image: c.cover ? `${SITE}/og/a/${id}.jpg` : FALLBACK_IMG, url: canonical,
  }), body);
}

async function profilePage(req, url, ctx) {
  const u = url.searchParams.get('u') || '';
  const origin = await fetch(req);
  if (!origin.ok || !USERNAME.test(u)) return origin;
  const c = await ogCard('user', u, ctx);
  if (!c) return rewrite(origin, seoBlock({ title: `Profile — ${BRAND}`, desc: 'A creator on Albums.ink.', image: FALLBACK_IMG, robots: 'noindex,follow' }));
  const n = +c.albums || 0;
  const name = c.title || c.username;
  const desc = c.desc || `${plural(n, 'album', 'albums')} by ${name} on ${BRAND}`;
  const body = `<article class="ssr" style="max-width:760px;margin:32px auto;padding:0 16px">
<h1>${esc(name)}</h1><p>@${esc(c.username)} · ${esc(plural(n, 'public album', 'public albums'))}</p>
${c.desc ? `<p>${esc(c.desc)}</p>` : ''}</article>`;
  return rewrite(origin, seoBlock({
    title: `${name} (@${c.username}) — ${BRAND}`, desc,
    image: c.avatar ? `${SITE}/og/u/${encodeURIComponent(c.username)}.jpg` : FALLBACK_IMG,
    url: `${SITE}/profile.html?u=${encodeURIComponent(c.username)}`,
  }), body);
}

/** Картинка превью на своём домене: байты обложки с кэшем на сутки. */
async function ogImage(kind, key, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`${SITE}/og/${kind}/${encodeURIComponent(key)}.jpg`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const r = await fetch(`${SUPABASE_URL}/functions/v1/og/${kind}/${encodeURIComponent(key)}/i`, { redirect: 'follow' });
  const type = r.headers.get('Content-Type') || '';
  if (!r.ok || !type.startsWith('image/')) return fetch(FALLBACK_IMG);
  const out = new Response(r.body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' } });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

/** Живая карта сайта: статические страницы из sitemap.xml Pages + публичные альбомы. */
async function sitemap(req) {
  const staticMap = await (await fetch(new Request(`${SITE}/sitemap.xml`, req))).text();
  const statics = [...staticMap.matchAll(/<url>[\s\S]*?<\/url>/g)].map(m => m[0])
    .filter(u => !u.includes('album.html?id='));
  const rows = [];
  for (let from = 0; from < 50000; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/albums?select=id,updated_at&visibility=eq.public`
      + `&published_at=not.is.null&moderation_status=eq.approved&hidden_at=is.null&order=updated_at.desc&offset=${from}&limit=1000`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    if (!r.ok) break;
    const b = await r.json(); rows.push(...b);
    if (b.length < 1000) break;
  }
  const albums = rows.map(a => `<url><loc>${SITE}/album.html?id=${a.id}</loc><lastmod>${String(a.updated_at).slice(0, 10)}</lastmod></url>`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...statics, ...albums].join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fetch(req);
    try {
      const p = url.pathname;
      if (p === '/album.html') return await albumPage(req, url, ctx);
      if (p === '/profile.html') return await profilePage(req, url, ctx);
      let m = p.match(/^\/og\/a\/([0-9a-f-]{36})\.jpg$/i);
      if (m) return await ogImage('a', m[1], ctx);
      m = p.match(/^\/og\/u\/([A-Za-z0-9_.-]{1,40})\.jpg$/);
      if (m) return await ogImage('u', m[1], ctx);
      if (p === '/sitemap.xml') return await sitemap(req);
      // Короткие адреса: /a/<id> и /u/<name> → существующие страницы (301).
      m = p.match(/^\/a\/([0-9a-f-]{36})\/?$/i);
      if (m) return Response.redirect(`${SITE}/album.html?id=${m[1]}`, 301);
      m = p.match(/^\/u\/([A-Za-z0-9_.-]{1,40})\/?$/);
      if (m) return Response.redirect(`${SITE}/profile.html?u=${m[1]}`, 301);
    } catch (e) {
      console.error('edge', e);   // любая ошибка — просто отдаём Pages как есть
    }
    return fetch(req);
  },
};
