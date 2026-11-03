/**
 * Переводы гайдов: /<lang>/guides/<slug>/ из английского оригинала
 * guides/<slug>/index.html и переводов i18n-guides/<slug>/<lang>.json.
 *
 *   node tools/build-guides-i18n.mjs --extract <slug>   → i18n-guides/<slug>/en.json
 *       (шаблон: title, desc и segments — внутренний HTML каждого блока по порядку;
 *        переводчик заполняет <lang>.json тем же массивом, инлайн-теги сохраняет)
 *   node tools/build-guides-i18n.mjs                     → все страницы + hreflang + sitemap
 *
 * Английская версия остаётся на /guides/<slug>/ и служит x-default. Каждая
 * версия получает self-canonical и hreflang на все языки. Ссылки на другие
 * гайды ведут на ту же языковую версию, если она есть; CTA на /events/
 * получают ?lang=<код>, чтобы лендинг открылся на нужном языке.
 * Самостоятельные гайды (без английского оригинала): <lang>.json с "standalone": true —
 * пишутся под спрос конкретной страны/языка и есть только на этом языке
 * (en → /guides/<slug>/, остальные → /<lang>/guides/<slug>/). Поля: title, desc,
 * h1, lead, body (мини-разметка: "## " h2, "### " h3, "- " ul, "1. " ol, "!cta" —
 * CTA-блок из cta, остальное — <p>), cta {h2,p,btn}, cta2 (финальный, необяз.),
 * faq [[q,a]…], type ("event" → CTA /events/, "social" → https://albums.ink/),
 * country/query (целевой рынок и запрос — служебные), date, related [slug…].
 * build.mjs вызывает этот скрипт после build-head.mjs (тот переписывает
 * <!-- seo --> и sitemap.xml, а блоки <!-- hreflang --> не трогает).
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBaselineLastmods, pickLastmod } from './sitemap-lastmod.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://albums.ink';
export const LANGS = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'vi', 'zh-CN', 'pt-BR', 'it', 'id'];
const SRC = join(ROOT, 'i18n-guides');

// Блоки для перевода, строго по порядку появления в <body>.
const BLOCK = /(<nav class="crumbs">)([\s\S]*?)(<\/nav>)|(<(h1|h2|h3|p|li)(?: [^>]*)?>)([\s\S]*?)(<\/\5>)|(<div><b>)([\s\S]*?)(<\/b>)|(<a class="btn[^"]*" href="[^"]*">)([\s\S]*?)(<\/a>)/g;

// Ячейки таблиц (<th>/<td>) — отдельный необязательный массив "tables" в <lang>.json.
const CELL = /(<(?:th|td)>)([\s\S]*?)(<\/(?:th|td)>)/g;
const cellsOf = (body) => { const o = []; body.replace(CELL, (...m) => { o.push(m[2]); return ''; }); return o; };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const urlFor = (lang, slug) => `${SITE}${lang === 'en' ? '' : '/' + lang}/guides/${slug}/`;

function splitBody(html) {
  const i = html.indexOf('<body'); return [html.slice(0, i), html.slice(i)];
}
function segmentsOf(body) {
  const out = [];
  body.replace(BLOCK, (...m) => { out.push(m[2] ?? m[6] ?? m[9] ?? m[12]); return ''; });
  return out;
}
const meta = (head, re) => (head.match(re) || [])[1];

async function extract(slug) {
  const html = await readFile(join(ROOT, 'guides', slug, 'index.html'), 'utf8');
  const [head, body] = splitBody(html);
  const data = {
    title: unesc(meta(head, /<title>([\s\S]*?)<\/title>/)),
    desc: unesc(meta(head, /<meta name="description" content="([^"]*)"/)),
    segments: segmentsOf(body),
  };
  await mkdir(join(SRC, slug), { recursive: true });
  await writeFile(join(SRC, slug, 'en.json'), JSON.stringify(data, null, 1) + '\n');
  console.log(`extracted ${data.segments.length} segments → i18n-guides/${slug}/en.json`);
}

function hreflangBlock(slug, langs) {
  return ['<!-- hreflang -->',
    ...langs.map(l => `<link rel="alternate" hreflang="${l}" href="${urlFor(l, slug)}">`),
    `<link rel="alternate" hreflang="x-default" href="${urlFor('en', slug)}">`,
    '<!-- /hreflang -->'].join('\n');
}
function putHreflang(html, block) {
  html = html.replace(/\n?<!-- hreflang -->[\s\S]*?<!-- \/hreflang -->/, '');
  return html.replace('<!-- /seo -->', `<!-- /seo -->\n${block}`);
}

async function render(slug, lang, langs) {
  const en = await readFile(join(ROOT, 'guides', slug, 'index.html'), 'utf8');
  const tr = JSON.parse(await readFile(join(SRC, slug, `${lang}.json`), 'utf8'));
  const [head0, body0] = splitBody(en);
  const segs = segmentsOf(body0);
  if (tr.segments.length !== segs.length) throw new Error(`${slug}/${lang}: ${tr.segments.length} segments, expected ${segs.length}`);
  for (const s of tr.segments) if (/\b(shots?|shooting)\b/i.test(s)) throw new Error(`${slug}/${lang}: banned word in "${s.slice(0, 60)}"`);

  const cells = cellsOf(body0);
  if (cells.length && tr.tables && tr.tables.length !== cells.length) throw new Error(`${slug}/${lang}: ${tr.tables.length} table cells, expected ${cells.length}`);
  if (cells.length && !tr.tables) console.warn(`warn: ${slug}/${lang}: table cells not translated`);
  let k = 0;
  let body = body0.replace(BLOCK, (...m) => {
    const t = tr.segments[k++];
    if (m[1]) return m[1] + t + m[3];
    if (m[4]) return m[4] + t + m[7];
    if (m[8]) return m[8] + t + m[10];
    return m[11] + t + m[13];
  });
  if (cells.length && tr.tables) { let c = 0; body = body.replace(CELL, (all, a, t, b) => a + tr.tables[c++] + b); }
  // Ссылки: гайды — на эту же языковую версию, если она есть; /events/ — с ?lang.
  body = body.replace(/href="(?:https:\/\/albums\.ink)?\/guides\/([a-z0-9-]+)\/"/g, (all, s) =>
    existsSync(join(SRC, s, `${lang}.json`)) ? `href="/${lang}/guides/${s}/"` : all);
  body = body.replace(/href="(?:https:\/\/albums\.ink)?\/events\/"/g, `href="/events/?lang=${lang}"`);

  const url = urlFor(lang, slug);
  const title = esc(tr.title), desc = esc(tr.desc);
  let head = head0
    .replace('<html lang="en">', `<html lang="${lang}" data-lang="${lang}">`)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${desc}`)
    .replace(/(<link rel="canonical" href=")[^"]*/, `$1${url}`)
    .replace(/(<meta property="og:url" content=")[^"]*/, `$1${url}`)
    .replace(/(<meta (?:property="og|name="twitter):title" content=")[^"]*/g, `$1${title}`)
    .replace(/(<meta (?:property="og|name="twitter):description" content=")[^"]*/g, `$1${desc}`)
    .replace(/<meta property="og:type"/, `<meta property="og:locale" content="${lang.replace('-', '_')}">\n<meta property="og:type"`);
  // JSON-LD: FAQ и Article — из переведённого текста.
  const faq = [...body.matchAll(/<div><b>([\s\S]*?)<\/b><p>([\s\S]*?)<\/p><\/div>/g)]
    .map(([, q, a]) => ({ '@type': 'Question', name: unesc(q), acceptedAnswer: { '@type': 'Answer', text: unesc(a) } }));
  const h1 = unesc((body.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1] || tr.title);
  head = head.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, (all, j) => {
    const d = JSON.parse(j);
    if (d['@type'] === 'FAQPage' && faq.length) d.mainEntity = faq;
    if (d['@type'] === 'Article') Object.assign(d, { headline: h1, mainEntityOfPage: url, inLanguage: lang });
    return `<script type="application/ld+json">${JSON.stringify(d)}</script>`;
  });
  head = putHreflang(head, hreflangBlock(slug, langs));
  const out = join(ROOT, lang, 'guides', slug, 'index.html');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, head + body);
  return url;
}

// ---------- самостоятельные гайды ----------
const UI_REF = 'voice-guest-book'; // откуда берём локализованные «Гайды / Частые вопросы / Ещё гайды»
async function uiStrings(lang) {
  const en = JSON.parse(await readFile(join(SRC, UI_REF, 'en.json'), 'utf8')).segments;
  const tr = lang === 'en' ? en : JSON.parse(await readFile(join(SRC, UI_REF, `${lang}.json`), 'utf8')).segments;
  return { crumbs: tr[0], faq: tr[en.indexOf('Frequently asked questions')], more: tr[en.indexOf('More guides')] };
}
function miniMarkup(lines, ctaHtml) {
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const l = raw.trim();
    let m;
    if (l === '!cta') { close(); out.push(ctaHtml); continue; }
    if ((m = l.match(/^- (.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${m[1]}</li>`); continue; }
    if ((m = l.match(/^\d+\. (.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${m[1]}</li>`); continue; }
    close();
    if ((m = l.match(/^### (.*)$/))) out.push(`<h3>${m[1]}</h3>`);
    else if ((m = l.match(/^## (.*)$/))) out.push(`<h2>${m[1]}</h2>`);
    else out.push(`<p>${l}</p>`);
  }
  close();
  return out.join('\n');
}
const ctaBlock = (c, href) => `<div class="cta cta-big">\n  <h2>${c.h2}</h2>\n  <p>${c.p}</p>\n  <a class="btn btn-big" href="${href}">${c.btn}</a>\n</div>`;
const DEFAULT_RELATED = {
  event: ['collect-wedding-photos-from-guests', 'qr-code-for-photos-at-party', 'how-to-collect-photos-from-event-guests'],
  social: ['how-to-make-a-photo-story', 'private-photo-sharing-for-family', 'add-voice-to-photos'],
};
async function renderStandalone(slug, lang, tr) {
  for (const k of ['title', 'desc', 'h1', 'lead', 'body', 'cta', 'faq', 'type']) if (!tr[k]) throw new Error(`${slug}/${lang}: standalone guide needs "${k}"`);
  const all = [tr.title, tr.desc, tr.h1, tr.lead, ...tr.body, JSON.stringify(tr.cta), JSON.stringify(tr.cta2 || {}), JSON.stringify(tr.faq)].join('\n');
  if (/\b(shots?|shooting)\b/i.test(all)) throw new Error(`${slug}/${lang}: banned word (shot/shooting)`);
  if (/forever|indefinite|\bapps?\b/i.test(all)) throw new Error(`${slug}/${lang}: banned word (forever/indefinite/app)`);
  const ui = await uiStrings(lang);
  const pre = lang === 'en' ? '' : `/${lang}`;
  const href = tr.type === 'event' ? (lang === 'en' ? 'https://albums.ink/events/' : `/events/?lang=${lang}`) : 'https://albums.ink/';
  const url = urlFor(lang, slug);
  const tpl = await readFile(join(ROOT, 'guides', UI_REF, 'index.html'), 'utf8');
  const [head0] = splitBody(tpl);
  const title = esc(tr.title), desc = esc(tr.desc);
  const img = `https://albums.ink/img/og/${tr.type === 'event' ? 'og-events' : 'og-home'}.jpg`;
  const date = tr.date || new Date().toISOString().slice(0, 10);
  const ld = [
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: tr.faq.map(([q, a]) => ({ '@type': 'Question', name: unesc(q), acceptedAnswer: { '@type': 'Answer', text: unesc(a) } })) },
    { '@context': 'https://schema.org', '@type': 'Article', headline: unesc(tr.h1), mainEntityOfPage: url, inLanguage: lang, image: img, datePublished: date, dateModified: tr.modified || date,
      author: { '@type': 'Organization', name: 'Albums', url: 'https://albums.ink/' }, publisher: { '@type': 'Organization', name: 'Albums', url: 'https://albums.ink/' } },
  ];
  const seo = ['<!-- seo -->', `<title>${title}</title>`, `<meta name="description" content="${desc}">`, `<link rel="canonical" href="${url}">`,
    `<meta property="og:locale" content="${lang.replace('-', '_')}">`, '<meta property="og:type" content="article">', '<meta property="og:site_name" content="Albums.ink">',
    `<meta property="og:url" content="${url}">`, `<meta property="og:title" content="${title}">`, `<meta property="og:description" content="${desc}">`,
    `<meta property="og:image" content="${img}">`, '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:title" content="${title}">`, `<meta name="twitter:description" content="${desc}">`, `<meta name="twitter:image" content="${img}">`,
    ...ld.map(d => `<script type="application/ld+json">${JSON.stringify(d)}</script>`), '<!-- /seo -->'].join('\n');
  const head = head0.replace('<html lang="en">', `<html lang="${lang}" data-lang="${lang}">`)
    .replace(/<!-- seo -->[\s\S]*?<!-- \/seo -->/, seo)
    .replace(/\n?<!-- hreflang -->[\s\S]*?<!-- \/hreflang -->/, '')
    .replace('<!-- /seo -->', `<!-- /seo -->\n${hreflangBlock(slug, [lang]).replace(/\n<link rel="alternate" hreflang="x-default"[^\n]*/, '')}`);
  const cards = [];
  for (const r of tr.related || DEFAULT_RELATED[tr.type] || []) {
    const f = join(SRC, r, `${lang}.json`); if (!existsSync(f)) continue;
    const d = JSON.parse(await readFile(f, 'utf8'));
    const t = esc(String(d.h1 || d.title).replace(/\s*\|\s*Albums\.ink\s*$/, ''));
    cards.push(`  <a class="card" href="${pre}/guides/${r}/"><h2>${t}</h2><p>${esc(d.desc)}</p></a>`);
  }
  const body = `<body>
<div class="site-shell"><div id="shell"></div></div>
<div class="wrap">
<nav class="crumbs">${ui.crumbs}</nav>
<article>
<h1>${tr.h1}</h1>
<p class="lead">${tr.lead}</p>
${miniMarkup(tr.body, ctaBlock(tr.cta, href))}
${ctaBlock(tr.cta2 || tr.cta, href)}
<section class="faq">
<h2>${ui.faq}</h2>
${tr.faq.map(([q, a]) => `  <div><b>${q}</b><p>${a}</p></div>`).join('\n')}
</section>
</article>
${cards.length ? `<section class="related">\n<h2>${ui.more}</h2>\n<div class="cards">\n${cards.join('\n')}\n</div>\n</section>\n` : ''}</div>
<script type="module" src="/js/guide.js"></script>
</body>
</html>
`;
  const out = lang === 'en' ? join(ROOT, 'guides', slug, 'index.html') : join(ROOT, lang, 'guides', slug, 'index.html');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, head + body);
  return url;
}

async function build() {
  if (!existsSync(SRC)) return;
  const urls = [];
  for (const slug of await readdir(SRC)) {
    // Самостоятельные гайды — только на своих языках, без английского шаблона.
    let standalone = false;
    for (const l of LANGS) {
      const f = join(SRC, slug, `${l}.json`);
      if (!existsSync(f)) continue;
      const tr = JSON.parse(await readFile(f, 'utf8'));
      if (tr.standalone) { standalone = true; urls.push({ url: await renderStandalone(slug, l, tr), file: join('i18n-guides', slug, `${l}.json`) }); }
    }
    if (standalone) continue;
    const langs = LANGS.filter(l => l === 'en' || existsSync(join(SRC, slug, `${l}.json`)));
    if (langs.length < 2) continue;
    const enPath = join(ROOT, 'guides', slug, 'index.html');
    await writeFile(enPath, putHreflang(await readFile(enPath, 'utf8'), hreflangBlock(slug, langs)));
    for (const l of langs) if (l !== 'en') urls.push({ url: await render(slug, l, langs), file: join('i18n-guides', slug, `${l}.json`) });
  }
  // В sitemap.xml (его только что переписал build-head) — переводы гайдов.
  // lastmod — дата git-коммита JSON-исходника (не «сегодня»), иначе каждый
  // build бампил бы сотни неизменённых URL.
  const smPath = join(ROOT, 'sitemap.xml');
  let sm = await readFile(smPath, 'utf8');
  sm = sm.replace(/\n?  <!-- guides-i18n -->[\s\S]*?<!-- \/guides-i18n -->/, '');
  const prev = await loadBaselineLastmods(ROOT);
  const block = ['  <!-- guides-i18n -->', ...urls.map(({ url, file }) => {
    const lastmod = pickLastmod(ROOT, file, prev, url);
    return `  <url><loc>${url}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`;
  }), '  <!-- /guides-i18n -->'].join('\n');
  sm = sm.replace('</urlset>', `${block}\n</urlset>`);
  await writeFile(smPath, sm);
  console.log(`guides-i18n: ${urls.length} pages`);
}

const i = process.argv.indexOf('--extract');
if (i > 0) await extract(process.argv[i + 1]); else await build();
