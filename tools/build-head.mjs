/**
 * Прошивка SEO-блока в <head> всех страниц + генерация sitemap.xml.
 *
 * Одна карта PAGES — единственный источник правды: title, description,
 * canonical, robots и JSON-LD каждой страницы, и она же даёт список URL
 * для sitemap. Руками эти теги больше не правятся: скрипт вставляет блок
 * между маркерами <!-- seo --> … <!-- /seo --> и при повторном запуске
 * заменяет его целиком. Первый запуск вычищает старые title/description/
 * og/twitter/canonical, где бы они ни стояли.
 *
 * Запуск: node tools/build-head.mjs  (build.mjs вызывает его сам).
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://albums.ink';
const OG_IMAGE = `${SITE}/og-cover.png`;

// Канонический абзац о продукте — он же в llms.txt и внешних карточках.
// Менять только синхронно во всех местах: совпадение формулировок в
// независимых источниках — сигнал уверенности для языковых моделей.
const CANON =
  'Albums turns photos, videos and voice notes into story albums with '
  + 'chapters and narration, and collects event photos from guests by QR '
  + 'code — no app, no signup. Private by design, exportable forever.';

const ORG_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Albums',
  url: `${SITE}/`,
  logo: `${SITE}/icon.svg`,
  email: 'support@albums.ink',
  description: CANON,
};

const APP_LD = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Albums',
  applicationCategory: 'PhotoApplication',
  operatingSystem: 'Web',
  url: `${SITE}/`,
  description: CANON,
  offers: [
    { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' },
    { '@type': 'Offer', name: 'Pro', price: '9.99', priceCurrency: 'USD' },
    { '@type': 'Offer', name: 'Event Album', price: '39.99', priceCurrency: 'USD' },
  ],
};

// FAQ дублирует видимый текст на странице (требование Google: разметка
// без текста на странице — повод для ручных санкций, а не для сниппета).
const faq = (pairs) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: pairs.map(([q, a]) => ({
    '@type': 'Question', name: q,
    acceptedAnswer: { '@type': 'Answer', text: a },
  })),
});

export const HOME_FAQ = [
  ['How do I collect photos from wedding or event guests?',
   'Create an Event Album and show or print its QR code. Guests scan it and upload photos and videos straight from the phone browser during and after the event. Everything lands in one album that belongs to you.'],
  ['Do guests need to download an app or sign up?',
   'No. Guests open the link or scan the QR code and upload from the browser. No app to install, no account to create.'],
  ['Can I download all the photos at once?',
   'Yes. Any album exports as a single archive with the original files — your photos are never locked in.'],
  ['Who owns the photos guests upload?',
   'The event owner. Guests keep their own copies, and the collected album belongs to the person who created the event.'],
  ['How is Albums different from a shared Google Photos album?',
   'Guests need no Google account and no app. The owner gets chapters, voice notes, a live photo wall, moderation, and a one-time price per event instead of a storage subscription.'],
  ['Is Albums free?',
   'Story albums are free. Pro is $9.99/month for more capacity. An Event Album is a $39.99 one-time purchase per event — guests never pay.'],
  ['Can I keep an album private or share it only with friends?',
   'Yes. Each album is public, private, friends-only, or friends-except-selected. Media are stored in a private bucket and served via signed URLs, so a private album cannot be opened by guessing a link.'],
  ['What is a story album?',
   'A curated collection of photos, videos and voice notes organized into chapters and read like a story — a trip, a wedding, a year of your child — rather than scrolled like a feed.'],
];

// Дословно повторяет видимый блок «Questions» на event-album.html — правило то
// же, что и для страницы цен: разметка дублирует текст страницы, а не свой.
export const EVENT_FAQ = [
  ['Do guests have to install an app?',
   'No. The phone camera opens an ordinary web page.'],
  ['Do they need an Albums account?',
   'Also no. They can upload without signing in — those photos stay anonymous. If they want their name on them, or want the files in their own account, they can sign in later.'],
  ['How many guests can I invite?',
   'As many as you like. There is one code and it never changes.'],
  ['How long does the album live?',
   'As long as you need. We delete nothing on a timer and charge nothing extra for storage.'],
  ['How many photos fit?',
   'There is no cap for the event: every guest’s space counts against their own account, and for photos it goes a long way. Heavy video is the exception — 50 MB per file.'],
  ['Can I hide the bad shots?',
   'Yes, each one has its own visibility. You can also turn on approval in advance, so guest photos wait for your decision.'],
  ['What if the code reaches strangers?',
   'Issue a new link — the old QR stops working. Everyone who already joined stays.'],
  ['Need a second album for another event?',
   'That is another purchase. Nothing expires: buy it in advance and create the album when the date is set.'],
];

// Дословно повторяет видимый блок «Questions» на pricing.html —
// разметка обязана дублировать текст страницы, а не выдумывать свой.
export const PRICING_FAQ = [
  ['What happens to my content if I cancel Pro?',
   "Nothing is deleted. If you are over the free storage limit, you won't be able to upload new media until you free up space, but everything already uploaded stays viewable and shareable."],
  ['Do event guests have to pay?',
   'No. Only the event organizer pays once. Guests join and upload for free.'],
  ['How do I get an invoice or a refund?',
   'Details are in the Refund Policy. For invoices and refund requests, write to sales@albums.ink.'],
];

/**
 * file → страница. path — канонический адрес (чистый для контентных страниц,
 * .html для приложенческих: их адреса разосланы людям). robots: 'noindex' у
 * служебных экранов. sitemap: только страницы с настоящим HTML-контентом.
 */
const PAGES = {
  'index.html': {
    path: '/',
    title: 'Albums — Photo Albums That Tell Stories',
    desc: 'Turn photos, videos and voice notes into story albums with chapters and narration. Collect event photos from guests with one QR code — no app, no signup.',
    ogTitle: 'Albums — put your life into stories',
    ogDesc: CANON,
    ld: [ORG_LD, APP_LD, faq(HOME_FAQ)],
    sitemap: { changefreq: 'weekly', priority: '1.0' },
  },
  'pricing.html': {
    path: '/pricing',
    title: 'Pricing: Free, Pro $9.99, Event Album $39.99 — Albums',
    desc: 'Albums pricing. Free story albums; Pro at $9.99/month for more space; Event Album at $39.99 one-time — guests upload by QR code and the album is yours forever.',
    ld: [faq(PRICING_FAQ)],
    sitemap: { changefreq: 'monthly', priority: '0.9' },
  },
  'event-album.html': {
    path: '/event-album',
    title: 'Event Album — collect every guest’s photos with one QR code',
    desc: 'One QR code for the whole event: guests upload photos from the phone browser — no app, no sign-up. $39.99 once, the album stays yours forever.',
    ld: [faq(EVENT_FAQ)],
    sitemap: { changefreq: 'monthly', priority: '0.9' },
  },
  'terms.html': {
    path: '/terms',
    title: 'Terms of Service — Albums',
    desc: 'The terms that govern your use of Albums: accounts, ownership of your content, Pro subscriptions, one-time Event Albums, acceptable use and liability.',
    sitemap: { changefreq: 'yearly', priority: '0.3' },
  },
  'privacy.html': {
    path: '/privacy',
    title: 'Privacy Policy — Albums',
    desc: 'How Albums handles your data: what we store, private media buckets with signed URLs, album visibility controls, cookies, analytics and your rights.',
    sitemap: { changefreq: 'yearly', priority: '0.3' },
  },
  'refunds.html': {
    path: '/refunds',
    title: 'Refund Policy — Albums',
    desc: 'When and how Albums refunds Pro subscriptions and one-time Event Album purchases, how long processing takes, and how to request a refund by email.',
    sitemap: { changefreq: 'yearly', priority: '0.3' },
  },

  /* -------- приложение: индексируемые поверхности без sitemap (пока SPA) -------- */
  'album.html': {
    path: '/album.html',
    title: 'Album — Albums',
    desc: 'A story album on Albums: photos, videos and voice notes organized into chapters, with captions and the author’s narration.',
  },
  'profile.html': {
    path: '/profile.html',
    title: 'Profile — Albums',
    desc: 'A creator profile on Albums: their story albums, posts and friends.',
  },
  'posts.html': {
    path: '/posts.html',
    title: 'Posts — Albums',
    desc: 'The posts feed on Albums: photos, videos and carousels from creators.',
  },
  'event.html': {
    path: '/event.html',
    title: 'Event Albums — Collect Guest Photos by QR | Albums',
    desc: 'Create an Event Album: guests scan one QR code and upload photos and videos from the phone browser — no app, no signup. $39.99 one-time, yours forever.',
  },

  /* -------- служебные экраны: noindex,follow -------- */
  'join.html': {
    path: '/join.html', robots: 'noindex,follow',
    title: 'Add your photos — Albums',
    desc: 'Upload your photos and videos to a shared event album — straight from your phone, no app needed.',
  },
  'editor.html': {
    path: '/editor.html', robots: 'noindex,follow',
    title: 'Album editor — Albums',
    desc: 'Create and edit story albums: chapters, media, captions and voice notes.',
  },
  'calendar.html': {
    path: '/calendar.html', robots: 'noindex,follow',
    title: 'Calendar — Albums',
    desc: 'Your albums and memories laid out on a calendar.',
  },
  'friends.html': {
    path: '/friends.html', robots: 'noindex,follow',
    title: 'Friends — Albums',
    desc: 'Friend requests, your friends and people search on Albums.',
  },
  'stats.html': {
    path: '/stats.html', robots: 'noindex,follow',
    title: 'Statistics — Albums',
    desc: 'Views, reactions and audience statistics for your albums.',
  },
  'moderation.html': {
    path: '/moderation.html', robots: 'noindex,follow',
    title: 'Moderation — Albums',
    desc: 'Review guest uploads before they appear in the event album.',
  },
  'pro-thanks.html': {
    path: '/pro-thanks.html', robots: 'noindex,follow',
    title: 'Payment received — Albums',
    desc: 'Your Albums Pro subscription is active.',
  },
  'event-thanks.html': {
    path: '/event-thanks.html', robots: 'noindex,follow',
    title: 'Event Album ready — Albums',
    desc: 'Your Event Album is paid and ready — invite guests with the QR code.',
  },
  '404.html': {
    path: '/404.html', robots: 'noindex,follow',
    title: 'Page not found — Albums',
    desc: 'This page doesn’t exist. Albums is where photos, videos and voices become stories worth coming back to.',
  },
};

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function seoBlock(p) {
  const url = SITE + p.path;
  const ogTitle = p.ogTitle || p.title;
  const ogDesc = p.ogDesc || p.desc;
  const lines = [
    '<!-- seo -->',
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.desc)}">`,
    `<link rel="canonical" href="${url}">`,
  ];
  if (p.robots) lines.push(`<meta name="robots" content="${p.robots}">`);
  lines.push(
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Albums">',
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${esc(ogTitle)}">`,
    `<meta property="og:description" content="${esc(ogDesc)}">`,
    `<meta property="og:image" content="${OG_IMAGE}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(ogTitle)}">`,
    `<meta name="twitter:description" content="${esc(ogDesc)}">`,
    `<meta name="twitter:image" content="${OG_IMAGE}">`,
  );
  for (const ld of p.ld || []) {
    lines.push(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
  }
  lines.push('<!-- /seo -->');
  return lines.join('\n');
}

/** Убирает старые SEO-теги, расставленные руками до появления маркеров. */
function stripLegacy(html) {
  return html
    .replace(/^[ \t]*<title>[\s\S]*?<\/title>\r?\n?/gmi, '')
    .replace(/^[ \t]*<meta name="(description|robots|twitter:[^"]*)"[^>]*>\r?\n?/gmi, '')
    .replace(/^[ \t]*<meta property="og:[^"]*"[^>]*>\r?\n?/gmi, '')
    .replace(/^[ \t]*<link rel="canonical"[^>]*>\r?\n?/gmi, '');
}

async function processPage(file, p) {
  const path = join(ROOT, file);
  let html = await readFile(path, 'utf8');
  const block = seoBlock(p);

  if (html.includes('<!-- seo -->')) {
    html = html.replace(/<!-- seo -->[\s\S]*?<!-- \/seo -->/, block);
  } else {
    html = stripLegacy(html);
    // Блок встаёт сразу после viewport — до CSP и стилей.
    const anchor = /(<meta name="viewport"[^>]*>\r?\n?)/;
    if (!anchor.test(html)) throw new Error(`${file}: viewport meta not found`);
    html = html.replace(anchor, `$1${block}\n`);
  }
  await writeFile(path, html);
}

async function writeSitemap() {
  const rows = [];
  for (const [file, p] of Object.entries(PAGES)) {
    if (!p.sitemap) continue;
    const { mtime } = await stat(join(ROOT, file));
    const lastmod = mtime.toISOString().slice(0, 10);
    rows.push(`  <url><loc>${SITE + p.path}</loc><lastmod>${lastmod}</lastmod>`
      + `<changefreq>${p.sitemap.changefreq}</changefreq>`
      + `<priority>${p.sitemap.priority}</priority></url>`);
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + rows.join('\n') + '\n</urlset>\n';
  await writeFile(join(ROOT, 'sitemap.xml'), xml);
}

for (const [file, p] of Object.entries(PAGES)) await processPage(file, p);
await writeSitemap();
console.log(`build-head: ${Object.keys(PAGES).length} pages, sitemap written`);
