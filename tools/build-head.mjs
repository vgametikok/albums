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
// Картинки превью 1200×630 (img/og/, JPG < 100 КБ). Краулеры мессенджеров JS
// не выполняют, поэтому всё, что они видят, — этот статический блок.
const OG = {
  home: { src: `${SITE}/img/og/og-home.jpg`, alt: 'Albums.ink — your memories, told as stories: story albums and QR photo albums for weddings and events' },
  events: { src: `${SITE}/img/og/og-events.jpg`, alt: 'A QR code sign on a wedding table and a phone full of guest photos — every guest photo with one QR code on Albums.ink' },
  album: { src: `${SITE}/img/og/og-album.jpg`, alt: 'Albums.ink — a photo album worth opening: photos, videos and voice notes told chapter by chapter' },
};
const OG_IMAGE = OG.events.src;   // картинка статей-гайдов (JSON-LD Article)
const BRAND = 'Albums.ink';

// Те же значения, что в js/config.js и src/index.js. Ключ публикуемый —
// он и так уходит в браузер каждому посетителю, секрета тут нет.
const SUPABASE_URL = 'https://rizveurkjpcwrmbtoawj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vpoMQyLN_a1CeYBPuGIuIA_VI5x07JD';

// Канонический абзац о продукте — он же в llms.txt и внешних карточках.
// Менять только синхронно во всех местах: совпадение формулировок в
// независимых источниках — сигнал уверенности для языковых моделей.
const CANON =
  'Albums collects wedding and event photos from guests by QR code — no app, '
  + 'no signup, no per-guest limits, full export — lets guests keep their photos '
  + 'in their own free account, and turns memories into story albums with '
  + 'chapters and narration.';

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
    { '@type': 'Offer', name: 'Event Album — Small (100 GB, for about 100 guests)', price: '39.99', priceCurrency: 'USD' },
    { '@type': 'Offer', name: 'Event Album — Medium (200 GB, for about 250 guests)', price: '69.99', priceCurrency: 'USD' },
    { '@type': 'Offer', name: 'Event Album — Large (400 GB, for about 500 guests)', price: '129.99', priceCurrency: 'USD' },
  ],
};

// Главная — лента для всех, цены на ней нет намеренно (они на /events/ и
// /pricing), поэтому и в разметке главной офферов с ценами нет.
const { offers: _offers, ...APP_LD_HOME } = APP_LD;

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

// Статья-гайд: заголовок совпадает с <h1> на странице.
const article = (headline, path) => ({
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline,
  mainEntityOfPage: SITE + path,
  image: OG_IMAGE,
  datePublished: '2026-10-03',
  dateModified: '2026-10-03',
  author: { '@type': 'Organization', name: 'Albums', url: SITE + '/' },
  publisher: { '@type': 'Organization', name: 'Albums', url: SITE + '/' },
});

// Вопросы с бывшей гостевой витрины главной. Сама витрина переехала на
// /events/, и эти вопросы (кроме повторов) теперь часть EVENT_FAQ ниже.
export const HOME_FAQ = [
  ['How do I collect photos from wedding or event guests?',
   'Create an Event Album and show or print its QR code. Guests scan it and upload photos and videos straight from the phone browser during and after the event. Everything lands in one album that belongs to you.'],
  ['Do guests need to download an app or sign up?',
   'No. Guests open the link or scan the QR code and upload from the browser. No app to install, no account to create.'],
  ['How long does the event album live?',
   'Files are stored for 6 months from the first upload into the album — not from the payment or from creating it — and you can extend storage by another 6 months. You can download everything as one archive at any time.'],
  ['Can I download all the photos at once?',
   'Yes. Any album exports as a single archive with the original files — your photos are never locked in.'],
  ['Who owns the photos guests upload?',
   'The event owner. And guests keep their own photos: after signing in, everything a guest uploaded is saved to their own album in their own free account as well.'],
  ['How is Albums different from a shared Google Photos album?',
   'Guests need no Google account and no app. The owner gets chapters, voice notes, a live photo wall, moderation, and a one-time price per event instead of a storage subscription.'],
  ['Is Albums free?',
   'Story albums are free. Pro is $9.99/month for more capacity. An Event Album is a one-time purchase per event, from $39.99 — guests never pay.'],
  ['Can I keep an album private or share it only with friends?',
   'Yes. Each album is public, private, friends-only, or friends-except-selected. Media are stored in a private bucket and served via signed URLs, so a private album cannot be opened by guessing a link.'],
  ['What is a story album?',
   'A curated collection of photos, videos and voice notes organized into chapters and read like a story — a trip, a wedding, a year of your child — rather than scrolled like a feed.'],
];

// Дословно повторяет видимый блок «Questions» на /events/ (events/index.html):
// вопросы лендинга плюс неповторяющиеся вопросы с бывшей витрины главной, в
// том же порядке, что на странице. Разметка дублирует текст страницы, а не свой.
const EA_FAQ = [
  ['Do guests have to install an app?',
   'No. The phone camera opens an ordinary web page.'],
  ['Do they need an Albums account?',
   'Also no. They can upload without signing in — those photos stay anonymous. If they want their name on them, or want the files in their own account, they can sign in later.'],
  ['How many guests can I invite?',
   "As many as you like. The 100, 250 or 500 on the plans is only a guide for choosing one: we don't count or limit guests or uploads, and each guest can upload as many times as they like. The only real limit is storage. There is one code and it never changes."],
  ['How long does the album live?',
   'Files are stored for 6 months from the first upload into the album — not from the payment or from creating it. Before the period ends you can extend storage by another 6 months or download everything as one archive.'],
  ['How many photos fit?',
   'Small holds 100 GB, Medium 200 GB and Large 400 GB — tens of thousands of photos. Ran out of space? No problem — you can add more. Video is capped at 50 MB per file.'],
  ['Can I hide the bad photos?',
   'Yes, each one has its own visibility. You can also turn on approval in advance, so guest photos wait for your decision.'],
  ['What if the code reaches strangers?',
   'Issue a new link — the old QR stops working. Everyone who already joined stays.'],
  ['Need a second album for another event?',
   "That is another purchase. Buy it in advance and start the album once the date is set — there's no deadline to start, and storage begins with the first upload."],
];
export const EVENT_FAQ = [
  HOME_FAQ[0], ...EA_FAQ.slice(0, 4), HOME_FAQ[3], HOME_FAQ[4],
  ...EA_FAQ.slice(4), HOME_FAQ[5], HOME_FAQ[6],
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
    title: 'Albums.ink — QR Photo Albums for Weddings & Events, and Story Albums',
    og: 'home',
    desc: 'Collect every guest photo from your wedding or event with one QR code — no app, no signup, full export. And turn memories into story albums with chapters, videos and voice notes.',
    ogTitle: 'Albums.ink — every guest photo with one QR code, and albums told as stories',
    ogDesc: CANON,
    ld: [ORG_LD, APP_LD_HOME],
    sitemap: { changefreq: 'weekly', priority: '1.0' },
  },
  'pricing.html': {
    path: '/pricing',
    title: 'Pricing: Free, Pro $9.99, Event Album from $39.99 — Albums.ink',
    og: 'events',
    desc: 'Albums pricing. Free story albums; Pro at $9.99/month for more space; Event Album from $39.99 one-time — Small, Medium or Large (100–400 GB) for events of about 100 to 500 guests who upload by QR code. Taxes included.',
    ld: [faq(PRICING_FAQ)],
    sitemap: { changefreq: 'monthly', priority: '0.9' },
  },
  // Лендинг QR-альбомов. Раньше жил в event-album.html — теперь там только
  // переадресация сюда (noindex + canonical), поэтому в карте её нет.
  'events/index.html': {
    path: '/events/',
    title: 'Event QR Photo Albums — Every Guest Photo with One QR Code | Albums.ink',
    og: 'events',
    ogTitle: 'Every guest photo. One QR code.',
    ogDesc: 'A QR photo album for your wedding or event: guests scan the code on the table and upload photos and videos from their phones — no app, no signup. From $39.99 one-time.',
    desc: 'Collect wedding and event photos from guests with one QR code — no app, no signup, from $39.99 one-time per event. Storage for 6 months from the first upload, extendable; full export anytime, and guests keep their photos too.',
    ld: [APP_LD, faq(EVENT_FAQ)],
    sitemap: { changefreq: 'monthly', priority: '0.9' },
  },
  // Гайды (SEO): английские статьи, FAQ-разметка совпадает с видимым текстом.
  'guides/index.html': {
    path: '/guides/',
    title: 'Guides: Collecting Wedding and Event Photos from Guests | Albums.ink',
    og: 'events',
    desc: 'Practical guides for couples and hosts: how to collect wedding photos from guests without an app, QR code table signs, and QR codes for party photos, voice guest books, baby shower and memorial photo albums, and shared albums for iPhone and Android.',
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/collect-wedding-photos-from-guests/index.html': {
    og: 'events',
    path: '/guides/collect-wedding-photos-from-guests/',
    title: "How to Collect Wedding Photos from Guests (No App Needed) | Albums.ink",
    desc: "A practical guide to gathering every guest photo and video from your wedding: why group chats and apps fail, how a QR code album works, what to set up before the day, and how to keep it all afterwards.",
    ld: [faq([["How do I collect photos from wedding guests without an app?", "Put a QR code on every table. Guests scan it with the phone camera and upload photos and videos from the browser — no app and no account. With an Event Album on Albums everything lands in one album that belongs to you."], ["Do guests need to sign up to upload photos?", "No. Guests can upload without signing in, and their photos stay anonymous. If they want their name on them, or want the files in their own free account, they can sign in later."], ["How long can guests keep uploading?", "The upload window never closes. Storage runs 6 months from the first upload and can be extended by another 6 months."], ["How much does a wedding guest photo album cost?", "An Event Album is a one-time purchase per event: from $39.99 (Small), $69.99 (Medium) or $129.99 (Large), taxes included. Guests never pay."], ["Can I download all the wedding photos at once?", "Yes. The whole album downloads as one archive, with files by chapter and a text file of captions."]]), article("How to collect wedding photos from guests — without an app", '/guides/collect-wedding-photos-from-guests/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/wedding-qr-code-table-signs/index.html': {
    og: 'events',
    path: '/guides/wedding-qr-code-table-signs/',
    title: "Wedding QR Code Table Signs: Wording and Placement Ideas | Albums.ink",
    desc: "Practical ideas for wedding QR code signs: what to write, where to place them, sizes, and the small details that make guests scan and upload their photos.",
    ld: [faq([["What should a wedding QR code sign say?", "Keep it short: your names, the date, the QR code and one instruction such as “Scan to add your photos”. Adding “no app, no sign-up” removes the main reason guests hesitate."], ["Where should I put QR codes at a wedding?", "One sign per table works best, plus the bar, the dessert table, the guest book and the photo corner. Showing the code on the venue screen next to a live photo wall also helps."], ["How big should a QR code be on a table sign?", "At least about 3–4 cm (1.5 in) across, dark on a light background, on matte paper. Test a printed sign with two phones in the venue light before printing them all."], ["What if the QR code gets shared with strangers?", "With an Event Album on Albums you can issue a new link: the old QR stops working and guests who already joined stay."]]), article("Wedding QR code photo sharing: table sign ideas that guests actually scan", '/guides/wedding-qr-code-table-signs/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/google-photos-vs-qr-guest-album/index.html': {
    og: 'events',
    path: '/guides/google-photos-vs-qr-guest-album/',
    title: "Google Photos Shared Album vs a QR Guest Album for Weddings | Albums.ink",
    desc: "Comparing a Google Photos shared album with a QR code guest album for collecting wedding photos: guest experience, privacy, organization, storage and cost.",
    ld: [faq([["How is Albums different from a shared Google Photos album?", "Guests need no Google account and no app — they scan a QR code and upload from the browser. The owner gets chapters, voice notes, a live photo wall, moderation, and a one-time price per event instead of a storage subscription."], ["Can wedding guests upload without a Google account?", "Yes. With an Event Album on Albums, guests upload photos and videos from the phone browser without any account."], ["Is a QR guest album free?", "Story albums on Albums are free. An Event Album with the QR code is a one-time purchase per event, from $39.99; guests never pay."], ["Can I control which guest photos are visible?", "Yes. Every photo can be shown to everyone, kept for friends, or hidden, and you can turn on approval so guest photos wait for your decision."]]), article("Google Photos shared album vs a QR guest album for your wedding", '/guides/google-photos-vs-qr-guest-album/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/wedding-photo-sharing-app/index.html': {
    og: 'events',
    path: '/guides/wedding-photo-sharing-app/',
    title: "Wedding Photo Sharing App: Free vs QR Code Options Compared | Albums.ink",
    desc: "Choosing a wedding photo sharing app: free options, QR code apps with no download, what guests need, privacy, photo quality and price. Compared honestly.",
    ld: [faq([["What is the best wedding photo sharing app?", "The best one is the one guests actually use: no download, no account, works on iPhone and Android. A QR code album that opens in the browser meets all three."], ["Is there a free wedding photo sharing app?", "Google Photos and iCloud are free, but Google needs guest accounts and iCloud doesn't let Android guests upload. Free tiers of wedding apps are usually limited."], ["Do guests need to download an app?", "Not with a QR album: guests scan the code and upload from the phone browser."], ["Can guests upload videos?", "Yes, guests can upload both photos and videos."], ["How long are wedding photos stored?", "On Albums, storage runs for 6 months; you can download everything as a ZIP at any time."]]), article("Wedding photo sharing app: how to choose one guests will actually use", '/guides/wedding-photo-sharing-app/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/qr-code-for-photos-at-party/index.html': {
    og: 'events',
    path: '/guides/qr-code-for-photos-at-party/',
    title: "QR Code for Photos at a Party: Collect Every Guest Photo | Albums.ink",
    desc: "How to use a QR code for photos at a party: guests scan and upload to one album with no app. Setup, sign wording, birthday party ideas and keeping the album afterwards.",
    ld: [faq([["How do I make a QR code for photos at a party?", "Create an event album that generates a QR code for its upload page, print the code on table signs, and guests scan it with their phone camera to upload photos to one album."], ["Do guests need an app to upload party photos?", "No. The upload page opens in the phone browser on iPhone and Android, with no app and no account."], ["Can guests upload videos as well as photos?", "Yes. Guests can upload both photos and videos from their camera roll."], ["Can I control which party photos are visible?", "Yes. Turn on approval so photos wait for you, and show each photo to everyone, to friends only, or hide it."], ["Is there a free QR code for party photos?", "You can link a free QR generator to a cloud folder, but guests may need an account and there is no moderation. See how to make a QR code for photo sharing for a comparison."]]), article("QR code for photos at a party: how to collect every guest photo", '/guides/qr-code-for-photos-at-party/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/how-to-collect-photos-from-event-guests/index.html': {
    og: 'events',
    path: '/guides/how-to-collect-photos-from-event-guests/',
    title: "How to Collect Photos from Event Guests (Corporate & Private Events) | Albums.ink",
    desc: "How to collect photos from event guests with one QR code: conferences, company parties and private events. Getting attendees to upload, moderation, sharing and cost.",
    ld: [faq([["What is the easiest way to collect photos from event guests?", "Print a QR code that opens an upload page in the browser. Guests scan and upload during the event with no app or account, and everything lands in one album."], ["How do I collect photos from guests for free?", "You can share an editable Google Drive or Dropbox folder link, but many guests will need an account, and there is no approval or live wall."], ["Can guests upload videos too?", "Yes, guests can upload both photos and videos."], ["How do I keep inappropriate photos out of a corporate event album?", "Turn on approval so every upload waits for review, and hide any photo you don't want visible."], ["How long can guests keep uploading?", "The upload page stays open after the event; storage runs 6 months from the first upload and can be extended."]]), article("How to collect photos from event guests with one QR code", '/guides/how-to-collect-photos-from-event-guests/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/baby-shower-photo-album/index.html': {
    og: 'events',
    path: '/guides/baby-shower-photo-album/',
    title: "Baby Shower Photo Album: Collect Guest Photos + Photo Ideas | Albums.ink",
    desc: "How to make a baby shower photo album from guest photos with one QR code: no app, sign wording, baby shower photo ideas and games, and a keepsake album for the baby.",
    ld: [faq([["How do I collect photos from baby shower guests?", "Place a QR code at the gift table and on each table. Guests scan it and upload photos from the phone browser into one album, with no app or sign-up."], ["What should be in a baby shower photo album?", "Decorations, candid photos of the parents-to-be, gift opening, games, family generations, guest messages, the cake and a group photo."], ["What are good baby shower photo ideas?", "The bump with each grandparent-to-be, guests holding tiny outfits, the parents reading cards, a photo scavenger hunt and a baby photo guessing game."], ["Can relatives who can't attend see the photos?", "Yes. Send them the album link and they can follow the live photo wall and add their own photos and greetings."], ["Can I keep the baby shower album private?", "Yes. Keep the album hidden so only people with the link can open it, and turn on approval to check uploads first."]]), article("Baby shower photo album: collect every guest photo with one QR code", '/guides/baby-shower-photo-album/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/family-reunion-photo-ideas/index.html': {
    og: 'events',
    path: '/guides/family-reunion-photo-ideas/',
    title: "Family Reunion Photo Ideas + a Shared Photo Album for the Family | Albums.ink",
    desc: "Family reunion photo ideas, a photo scavenger hunt, and one shared photo album for the whole family: getting grandparents and teens to upload, old family photos, and a family archive.",
    ld: [faq([["What are good family reunion photo ideas?", "A whole-family group photo, photos by branch, a generations photo, recreated old family photos, matching shirts, and candid photos of elders telling stories."], ["How do I get everyone's photos from a family reunion?", "Share one album link and QR code. Relatives upload from the phone browser with no app or account, so every generation can take part."], ["What should be on a family reunion photo scavenger hunt?", "Prompts like every generation in one photo, the oldest and youngest relative together, cousins who just met and a recreated old family photo."], ["Can relatives who couldn't come add photos?", "Yes. Send them the link; they can add photos and follow the album from anywhere."], ["How do we preserve old family photos at the reunion?", "Set up a scanning corner, upload prints into an “Archive” chapter, and add voice notes from elders explaining each photo."]]), article("Family reunion photo ideas and one shared album for the whole family", '/guides/family-reunion-photo-ideas/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/graduation-party-photo-display-ideas/index.html': {
    og: 'events',
    path: '/guides/graduation-party-photo-display-ideas/',
    title: "Graduation Party Photo Display Ideas + Collecting Guest Photos | Albums.ink",
    desc: "Graduation party photo display ideas: memory table, photo board and a live photo wall, plus how to collect every guest photo from the ceremony and grad party with one QR code.",
    ld: [faq([["What do you put on a graduation photo board?", "Photos from each school year grouped by stage, with captions and years, and the graduation photo in the centre."], ["How do I display photos at a graduation party?", "Use a photo board, a year-by-year timeline, a memory table, then-and-now pairs, or a live digital photo wall that shows guest photos as they are uploaded."], ["How do I collect old photos of the graduate from family?", "Send relatives an album link a few weeks before; they upload from the phone browser with no app, and you download what you need for printing."], ["How many photos do I need for a graduation photo board?", "Usually 30–60: a few from each year plus key milestones."], ["Can guests upload videos of the ceremony?", "Yes, guests can upload both photos and videos."]]), article("Graduation party photo display ideas (and how to collect every guest photo)", '/guides/graduation-party-photo-display-ideas/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/memorial-photo-album/index.html': {
    og: 'events',
    path: '/guides/memorial-photo-album/',
    title: "Memorial Photo Album: Collect Photos of a Loved One from Family & Friends | Albums.ink",
    desc: "How to make a memorial photo album together: collect photos of a loved one from family and friends with a QR code, funeral photo display ideas, voice memories and a lasting album.",
    ld: [faq([["How do I collect photos of a loved one for a funeral?", "Create a private album and share its link with the funeral notice. Family and friends upload photos from the phone browser, and you download what you need for boards and a slideshow."], ["How many photos should be in a memorial slideshow?", "Around 40–80 photos for a 10–15 minute slideshow."], ["What can I display at a funeral besides photo boards?", "A timeline table with meaningful objects, a slideshow, a memory wall, memory cards on tables, or a live photo wall at a celebration of life."], ["Can the memorial album be private?", "Yes. Keep it hidden so only people with the link can open it, and turn on approval to review photos before they appear."], ["Can relatives keep adding photos later?", "Yes. Uploads stay open after the service, and storage can be extended."]]), article("Memorial photo album: gathering photos of a loved one from family and friends", '/guides/memorial-photo-album/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/bachelorette-party-photo-scavenger-hunt/index.html': {
    og: 'events',
    path: '/guides/bachelorette-party-photo-scavenger-hunt/',
    title: "Bachelorette Party Photo Scavenger Hunt + a Private Group Album | Albums.ink",
    desc: "A bachelorette party photo scavenger hunt list, more bachelorette party photo ideas, and one private album where the whole group uploads with a QR code.",
    ld: [faq([["What do you put on a bachelorette party photo scavenger hunt?", "Challenges like a selfie with a stranger in a veil, a stranger's marriage advice on video, the bride getting a free drink, a group pyramid and something old, new, borrowed and blue."], ["How long should a bachelorette scavenger hunt last?", "Usually one to two hours, or the whole night out with a hard deadline for uploads."], ["How do teams submit their photos?", "Upload them to a shared album from the phone browser via a link or QR code; no app or account needed."], ["Is there a clean version of the scavenger hunt?", "Yes — use family-friendly prompts like recreating the couple's first date, finding something blue, or a photo with the oldest couple you can find."], ["Can we keep the bachelorette photos private?", "Yes. Keep the album hidden, and show each photo to everyone, keep it for friends, or hide it."]]), article("Bachelorette party photo scavenger hunt (and one private album for the photos)", '/guides/bachelorette-party-photo-scavenger-hunt/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/shared-photo-album-iphone-android/index.html': {
    og: 'events',
    path: '/guides/shared-photo-album-iphone-android/',
    title: "Shared Photo Album for iPhone and Android: What Actually Works | Albums.ink",
    desc: "How to make a shared photo album for iPhone and Android users: iCloud Shared Albums, Google Photos and a browser-based QR album compared, for families, parties and events.",
    ld: [faq([["Can Android users add photos to an iCloud shared album?", "No. Android users can view a public website link of an iCloud Shared Album but cannot upload."], ["What is the best shared photo album for iPhone and Android?", "For mixed groups and events, a browser-based QR album works on any phone without an app or account. Google Photos works if everyone has a Google account."], ["How do I share photos between iPhone and Android without an app?", "Use an album with a web upload page: share its link or QR code, and people upload from Safari or Chrome."], ["Does Google Photos work on iPhone?", "Yes, through the Google Photos app with a Google account."], ["Do shared albums reduce photo quality?", "Often. iCloud Shared Albums store reduced copies and chats compress heavily; Albums stores photos at 2048 px on the long side."]]), article("Shared photo album for iPhone and Android: what actually works", '/guides/shared-photo-album-iphone-android/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/qr-code-for-photo-sharing/index.html': {
    og: 'events',
    path: '/guides/qr-code-for-photo-sharing/',
    title: "QR Code for Photo Sharing: How to Make One (Free Options Compared) | Albums.ink",
    desc: "How to make a QR code for photo sharing and photo upload: free QR generator + cloud folder vs an event album with a built-in QR code, what to check before printing, and common mistakes.",
    ld: [faq([["How do I create a QR code for photo sharing?", "Create a shared album with an upload page, generate a QR code for its link (event album services do this automatically), print it and test it on iPhone and Android."], ["Is there a free QR code for photo sharing?", "Yes: a free generator plus a shared Google Drive, Google Photos or Dropbox folder. The trade-offs are guest accounts, expiring dynamic codes and no moderation."], ["Do guests need an app to scan a QR code?", "No. Modern iPhone and Android cameras read QR codes, and a good upload page opens in the browser."], ["Can a QR code for photos expire?", "Static codes never expire, but dynamic codes from some free generators stop working after a trial. The code from an event album works as long as the album exists."], ["How big should a photo QR code be?", "About 8–10 cm (3–4 in) for a table sign, larger for posters seen from a distance, and always with high contrast."]]), article("QR code for photo sharing: how to make one guests can upload to", '/guides/qr-code-for-photo-sharing/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/voice-guest-book/index.html': {
    og: 'events',
    path: '/guides/voice-guest-book/',
    title: "Voice Guest Book: an Audio Guest Book Without a Phone Rental | Albums.ink",
    desc: "What a voice (audio) guest book is, how it compares to an audio guest book phone rental, and how to collect voice messages and photos from guests at a wedding or party with a QR code.",
    ld: [faq([["What is an audio guest book?", "A guest book where people leave recorded voice messages instead of writing, usually via a vintage phone, a voicemail line or a QR code on their own phones."], ["How does an audio guest book phone work?", "Guests lift the receiver, hear your greeting and speak after the beep; the phone saves recordings to a memory card you receive after the event."], ["Do I need to rent an audio guest book phone?", "No. With a QR event album guests record video messages on their own phones and upload them with their photos, and you can add voice notes yourself."], ["Can guests who can't attend leave a message?", "Yes, with a QR album: send them the link and they can upload from anywhere."], ["What should guests say in a voice guest book?", "Advice for the couple, how they know the hosts, a prediction for ten years from now, or a memory they've never shared."]]), article("Voice guest book: collect voice messages from guests without renting a phone", '/guides/voice-guest-book/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'terms.html': {
    path: '/terms',
    title: 'Terms of Service — Albums.ink',
    desc: 'The terms that govern your use of Albums: accounts, ownership of your content, Pro subscriptions, one-time Event Albums, acceptable use and liability.',
    sitemap: { changefreq: 'yearly', priority: '0.3' },
  },
  'privacy.html': {
    path: '/privacy',
    title: 'Privacy Policy — Albums.ink',
    desc: 'How Albums handles your data: what we store, private media buckets with signed URLs, album visibility controls, cookies, analytics and your rights.',
    sitemap: { changefreq: 'yearly', priority: '0.3' },
  },
  'refunds.html': {
    path: '/refunds',
    title: 'Refund Policy — Albums.ink',
    desc: 'When and how Albums refunds Pro subscriptions and one-time Event Album purchases, how long processing takes, and how to request a refund by email.',
    sitemap: { changefreq: 'yearly', priority: '0.3' },
  },

  /* -------- приложение: индексируемые поверхности без sitemap (пока SPA) -------- */
  'album.html': {
    path: '/album.html',
    selfCanonical: true,   // адрес различается параметром — canonical свой у каждого
    title: 'Album — Albums.ink',
    og: 'album',
    ogTitle: 'A photo album on Albums.ink',
    ogDesc: 'Photos, videos and voice notes, told chapter by chapter. Open the album on Albums.ink.',
    desc: 'A story album on Albums: photos, videos and voice notes organized into chapters, with captions and the author’s narration.',
  },
  'profile.html': {
    path: '/profile.html',
    selfCanonical: true,   // адрес различается параметром — canonical свой у каждого
    title: 'Profile — Albums.ink',
    og: 'album',
    desc: 'A creator profile on Albums: their story albums, posts and friends.',
  },
  'posts.html': {
    path: '/posts.html',
    title: 'Posts — Albums.ink',
    og: 'album',
    desc: 'The posts feed on Albums: photos, videos and carousels from creators.',
  },
  // Кабинет событий (приложение). Маркетинговая страница — /events/; кабинет
  // с тем же заголовком спорил бы с ней в поиске, поэтому он вне индекса.
  'event.html': {
    path: '/event.html', robots: 'noindex,follow',
    title: 'My events — Albums.ink',
    og: 'events',
    ogTitle: 'Event QR photo albums on Albums.ink',
    ogDesc: 'Every guest photo with one QR code — guests upload from their phones, no app, no signup.',
    desc: 'Manage your Event Albums: the QR code, the greeting for guests and everything they uploaded.',
  },

  /* -------- служебные экраны: noindex,follow -------- */
  'join.html': {
    path: '/join.html', robots: 'noindex,follow',
    title: 'Add your photos — Albums.ink',
    og: 'album',
    ogTitle: 'Add your photos to the event album',
    ogDesc: 'You’re invited to a shared event album on Albums.ink. Upload your photos and videos straight from your phone — no app, no signup.',
    desc: 'Upload your photos and videos to a shared event album — straight from your phone, no app needed.',
  },
  'editor.html': {
    path: '/editor.html', robots: 'noindex,follow',
    title: 'Album editor — Albums.ink',
    desc: 'Create and edit story albums: chapters, media, captions and voice notes.',
  },
  'calendar.html': {
    path: '/calendar.html', robots: 'noindex,follow',
    title: 'Calendar — Albums.ink',
    desc: 'Your albums and memories laid out on a calendar.',
  },
  'friends.html': {
    path: '/friends.html', robots: 'noindex,follow',
    title: 'Friends — Albums.ink',
    desc: 'Friend requests, your friends and people search on Albums.',
  },
  'stats.html': {
    path: '/stats.html', robots: 'noindex,follow',
    title: 'Statistics — Albums.ink',
    desc: 'Views, reactions and audience statistics for your albums.',
  },
  'moderation.html': {
    path: '/moderation.html', robots: 'noindex,follow',
    title: 'Moderation — Albums.ink',
    desc: 'Review guest uploads before they appear in the event album.',
  },
  'pro-thanks.html': {
    path: '/pro-thanks.html', robots: 'noindex,follow',
    title: 'Payment received — Albums.ink',
    desc: 'Your Albums Pro subscription is active.',
  },
  'event-thanks.html': {
    path: '/event-thanks.html', robots: 'noindex,follow',
    title: 'Event Album ready — Albums.ink',
    desc: 'Your Event Album is paid and ready — invite guests with the QR code.',
  },
  '404.html': {
    path: '/404.html', robots: 'noindex,follow',
    title: 'Page not found — Albums.ink',
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
  ];
  // Страницы-приложения различаются параметром (album.html?id=, profile.html?u=):
  // один жёсткий canonical на все адреса склеивал бы их в индексе в одну
  // страницу, и ни один альбом не проиндексировался бы. Без тега каждый адрес
  // канонизирует сам себя — это то, что нужно.
  if (!p.selfCanonical) lines.push(`<link rel="canonical" href="${url}">`);
  if (p.robots) lines.push(`<meta name="robots" content="${p.robots}">`);
  const img = OG[p.og || 'home'];
  lines.push(
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${BRAND}">`,
    // У страниц с параметром (album.html?id=…) общий og:url заставил бы Facebook
    // склеить все альбомы в одну ссылку — там краулер берёт адрес, по которому пришёл.
    ...(p.selfCanonical || ['/join.html', '/event.html', '/posts.html'].includes(p.path) ? [] : [`<meta property="og:url" content="${url}">`]),
    `<meta property="og:title" content="${esc(ogTitle)}">`,
    `<meta property="og:description" content="${esc(ogDesc)}">`,
    `<meta property="og:image" content="${img.src}">`,
    `<meta property="og:image:secure_url" content="${img.src}">`,
    '<meta property="og:image:type" content="image/jpeg">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${esc(img.alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(ogTitle)}">`,
    `<meta name="twitter:description" content="${esc(ogDesc)}">`,
    `<meta name="twitter:image" content="${img.src}">`,
    `<meta name="twitter:image:alt" content="${esc(img.alt)}">`,
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

const xmlEsc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Предел протокола sitemap — 50 000 адресов на файл. До него далеко, но молча
// обрезать нельзя: перевалим — будет видно в логе сборки, и придётся разбивать
// на sitemap-index.
const SITEMAP_MAX = 50000;

/**
 * Публичные альбомы для карты сайта.
 *
 * Читаем обычным PostgREST под публикуемым ключом, то есть ровно тем, что видит
 * аноним: политика albums_read опирается на can_view_album, и она сама отсекает
 * неопубликованные, скрытые, не прошедшие проверку и авторов в бане. Фильтры
 * ниже дублируют это явно — чтобы намерение читалось из кода, а не только из RLS.
 */
async function fetchPublicAlbums() {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const url = `${SUPABASE_URL}/rest/v1/albums`
      + '?select=id,updated_at&visibility=eq.public'
      + '&published_at=not.is.null&moderation_status=eq.approved'
      + `&order=updated_at.desc&offset=${from}&limit=${PAGE}`;
    const resp = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!resp.ok) throw new Error(`albums ${resp.status} ${await resp.text()}`);
    const batch = await resp.json();
    out.push(...batch);
    if (batch.length < PAGE || out.length >= SITEMAP_MAX) break;
  }
  return out;
}

/** Адреса альбомов из уже лежащего в репозитории sitemap.xml. */
async function previousAlbumRows() {
  try {
    const xml = await readFile(join(ROOT, 'sitemap.xml'), 'utf8');
    return xml.split('\n').filter(l => l.includes('/album.html?id='));
  } catch (_) { return []; }
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

  // Сборку это уронить не должно: недоступность Supabase в момент деплоя —
  // не повод не выкатить исправление в коде. Но и молча потерять все альбомы
  // из карты сайта нельзя, поэтому берём адреса из прошлой версии файла
  // (он лежит в репозитории) и громко жалуемся в лог.
  let albums = [];
  try {
    albums = await fetchPublicAlbums();
    for (const a of albums) {
      const loc = xmlEsc(`${SITE}/album.html?id=${a.id}`);
      const lastmod = String(a.updated_at || '').slice(0, 10);
      rows.push(`  <url><loc>${loc}</loc>`
        + (lastmod ? `<lastmod>${lastmod}</lastmod>` : '')
        + '<changefreq>monthly</changefreq><priority>0.6</priority></url>');
    }
    if (albums.length >= SITEMAP_MAX) {
      console.warn(`build-head: ВНИМАНИЕ — альбомов ${albums.length}, упёрлись в предел `
        + `${SITEMAP_MAX}; часть в карту не попала, пора делать sitemap-index`);
    }
  } catch (err) {
    const kept = await previousAlbumRows();
    rows.push(...kept);
    console.error(`build-head: ОШИБКА — не удалось получить альбомы (${err.message}); `
      + `в карте сайта оставлено ${kept.length} адресов из прошлой сборки`);
  }

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + rows.join('\n') + '\n</urlset>\n';
  await writeFile(join(ROOT, 'sitemap.xml'), xml);
  return albums.length;
}

for (const [file, p] of Object.entries(PAGES)) await processPage(file, p);
await writeSitemap();
console.log(`build-head: ${Object.keys(PAGES).length} pages, sitemap written`);
