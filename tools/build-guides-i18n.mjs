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
 * build.mjs вызывает этот скрипт после build-head.mjs (тот переписывает
 * <!-- seo --> и sitemap.xml, а блоки <!-- hreflang --> не трогает).
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://albums.ink';
export const LANGS = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'vi', 'zh-CN', 'pt-BR', 'it', 'id'];
const SRC = join(ROOT, 'i18n-guides');

// Блоки для перевода, строго по порядку появления в <body>.
const BLOCK = /(<nav class="crumbs">)([\s\S]*?)(<\/nav>)|(<(h1|h2|h3|p|li)(?: [^>]*)?>)([\s\S]*?)(<\/\5>)|(<div><b>)([\s\S]*?)(<\/b>)|(<a class="btn[^"]*" href="[^"]*">)([\s\S]*?)(<\/a>)/g;

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

  let k = 0;
  let body = body0.replace(BLOCK, (...m) => {
    const t = tr.segments[k++];
    if (m[1]) return m[1] + t + m[3];
    if (m[4]) return m[4] + t + m[7];
    if (m[8]) return m[8] + t + m[10];
    return m[11] + t + m[13];
  });
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

async function build() {
  if (!existsSync(SRC)) return;
  const urls = [];
  for (const slug of await readdir(SRC)) {
    const langs = LANGS.filter(l => l === 'en' || existsSync(join(SRC, slug, `${l}.json`)));
    if (langs.length < 2) continue;
    const enPath = join(ROOT, 'guides', slug, 'index.html');
    await writeFile(enPath, putHreflang(await readFile(enPath, 'utf8'), hreflangBlock(slug, langs)));
    for (const l of langs) if (l !== 'en') urls.push(await render(slug, l, langs));
  }
  // В sitemap.xml (его только что переписал build-head) — переводы гайдов.
  const smPath = join(ROOT, 'sitemap.xml');
  let sm = await readFile(smPath, 'utf8');
  sm = sm.replace(/\n?  <!-- guides-i18n -->[\s\S]*?<!-- \/guides-i18n -->/, '');
  const day = new Date().toISOString().slice(0, 10);
  const block = ['  <!-- guides-i18n -->', ...urls.map(u => `  <url><loc>${u}</loc><lastmod>${day}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`), '  <!-- /guides-i18n -->'].join('\n');
  sm = sm.replace('</urlset>', `${block}\n</urlset>`);
  await writeFile(smPath, sm);
  console.log(`guides-i18n: ${urls.length} pages`);
}

const i = process.argv.indexOf('--extract');
if (i > 0) await extract(process.argv[i + 1]); else await build();
