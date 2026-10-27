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
   'Guests need no Google account and no app. The owner gets chapters, voice notes, moderation, and a one-time price per event instead of a storage subscription.'],
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
    ld: [faq([["How do I collect photos from wedding guests without an app?", "Put a QR code on every table. Guests scan it with the phone camera and upload photos and videos from the browser — no app and no account. With an Event Album on Albums everything lands in one album that belongs to you."], ["Do guests need to sign up to upload photos?", "No. Guests can upload without signing in, and their photos stay anonymous. If they want their name on them, or want the files in their own free account, they can sign in later."], ["How long can guests keep uploading?", "The upload window never closes. Event album storage runs 6 months from the first upload and can be extended by another 6 months."], ["How much does a wedding guest photo album cost?", "An Event Album is a one-time purchase per event: from $39.99 (Small), $69.99 (Medium) or $129.99 (Large), taxes included. Guests never pay."], ["Can I download all the wedding photos at once?", "Yes. The whole album downloads as one archive, with files by chapter and a text file of captions."]]), article("How to collect wedding photos from guests — without an app", '/guides/collect-wedding-photos-from-guests/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/wedding-qr-code-table-signs/index.html': {
    og: 'events',
    path: '/guides/wedding-qr-code-table-signs/',
    title: "Wedding QR Code Table Signs: Wording and Placement Ideas | Albums.ink",
    desc: "Practical ideas for wedding QR code signs: what to write, where to place them, sizes, and the small details that make guests scan and upload their photos.",
    ld: [faq([["What should a wedding QR code sign say?", "Keep it short: your names, the date, the QR code and one instruction such as “Scan to add your photos”. Adding “no app, no sign-up” removes the main reason guests hesitate."], ["Where should I put QR codes at a wedding?", "One sign per table works best, plus the bar, the dessert table, the guest book and the photo corner. Showing the code on the venue screen also helps."], ["How big should a QR code be on a table sign?", "At least about 3–4 cm (1.5 in) across, dark on a light background, on matte paper. Test a printed sign with two phones in the venue light before printing them all."], ["What if the QR code gets shared with strangers?", "With an Event Album on Albums you can issue a new link: the old QR stops working and guests who already joined stay."]]), article("Wedding QR code photo sharing: table sign ideas that guests actually scan", '/guides/wedding-qr-code-table-signs/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/google-photos-vs-qr-guest-album/index.html': {
    og: 'events',
    path: '/guides/google-photos-vs-qr-guest-album/',
    title: "Google Photos Shared Album vs a QR Guest Album for Weddings | Albums.ink",
    desc: "Comparing a Google Photos shared album with a QR code guest album for collecting wedding photos: guest experience, privacy, organization, storage and cost.",
    ld: [faq([["How is Albums different from a shared Google Photos album?", "Guests need no Google account and no app — they scan a QR code and upload from the browser. The owner gets chapters, voice notes, moderation, and a one-time price per event instead of a storage subscription."], ["Can wedding guests upload without a Google account?", "Yes. With an Event Album on Albums, guests upload photos and videos from the phone browser without any account."], ["Is a QR guest album free?", "Story albums on Albums are free. An Event Album with the QR code is a one-time purchase per event, from $39.99; guests never pay."], ["Can I control which guest photos are visible?", "Yes. Every photo can be shown to everyone, kept for friends, or hidden, and you can turn on approval so guest photos wait for your decision."]]), article("Google Photos shared album vs a QR guest album for your wedding", '/guides/google-photos-vs-qr-guest-album/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/wedding-photo-sharing-app/index.html': {
    og: 'events',
    path: '/guides/wedding-photo-sharing-app/',
    title: "Wedding Photo Sharing App: Free vs QR Code Options Compared | Albums.ink",
    desc: "Choosing a wedding photo sharing app: free options, QR code apps with no download, what guests need, privacy, photo quality and price. Compared honestly.",
    ld: [faq([["What is the best wedding photo sharing app?", "The best one is the one guests actually use: no download, no account, works on iPhone and Android. A QR code album that opens in the browser meets all three."], ["Is there a free wedding photo sharing app?", "Google Photos and iCloud are free, but Google needs guest accounts and iCloud doesn't let Android guests upload. Free tiers of wedding apps are usually limited."], ["Do guests need to download an app?", "Not with a QR album: guests scan the code and upload from the phone browser."], ["Can guests upload videos?", "Yes, guests can upload both photos and videos."], ["How long are wedding photos stored?", "On Albums, an event (QR) album is stored for 6 months from the first upload and can be extended by another 6 months; regular albums have no time limit. You can download everything as a ZIP at any time."]]), article("Wedding photo sharing app: how to choose one guests will actually use", '/guides/wedding-photo-sharing-app/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/disposable-camera-app/index.html': {
    og: 'events',
    path: '/guides/disposable-camera-app/',
    title: "Disposable Camera App for Weddings & Events: QR Code, No Download | Albums.ink",
    desc: "Disposable camera app vs real disposable cameras for weddings and parties: cost, photo quality, QR code setup with no download, and how guests use it.",
    ld: [faq([["What is a disposable camera app?", "An app or web album that turns guests' phones into a shared event camera. With a QR code album guests scan and upload from the browser, with no download."], ["Is a disposable camera app cheaper than real disposable cameras?", "Usually yes: film cameras cost money per table plus developing, while a QR album is one price for the whole event, from $39.99."], ["Do guests need to download an app?", "Not with a QR album. Guests scan the code with the phone camera and upload in the browser."], ["Can I still keep a film look and a reveal?", "Yes. Keep the album private during the event and share it with everyone at a set moment, such as the next morning."], ["Can guests upload videos?", "Yes, guests can upload both photos and videos."], ["How good is the photo quality compared with film?", "Modern phones handle dark reception halls far better than cheap disposable cameras, and Albums keeps guest photos in up to 4K (3840 px on the long side)."]]), article("Disposable camera app for weddings and events: the QR code alternative to film cameras", '/guides/disposable-camera-app/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/digital-guest-book/index.html': {
    og: 'events',
    path: '/guides/digital-guest-book/',
    title: "Digital Guest Book for Weddings & Funerals: QR Code, Free Options | Albums.ink",
    desc: "What a digital guest book is, how a QR code guest book works for weddings, funerals and parties, free vs paid options, and wording ideas for the sign.",
    ld: [faq([["What is a digital guest book?", "An online page where guests leave wishes, photos, videos and memories, usually reached by scanning a QR code at the event."], ["How does a QR code guest book work?", "Guests scan the code with their phone camera, an upload page opens in the browser, and they add photos, videos and a wish — no app or account."], ["Is there a free digital guest book?", "Shared documents, forms or cloud folders are free, but guests may need accounts and photos and wishes end up in different places."], ["Can I use a digital guest book at a funeral?", "Yes. Keep the album hidden, hide anything the family doesn’t want visible, and share the link with the funeral notice so distant friends can add memories."], ["Can guests who didn't attend sign it?", "Yes. Send them the link and they can add photos and wishes from anywhere."], ["How long are entries stored?", "On Albums, an event (QR) album is stored for 6 months from the first upload and can be extended by another 6 months; regular albums have no time limit. You can download everything as a ZIP at any time."]]), article("Digital guest book: how to collect wishes, photos and memories with a QR code", '/guides/digital-guest-book/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },  'guides/best-photo-sharing-app-for-events/index.html': {
    og: 'events',
    path: '/guides/best-photo-sharing-app-for-events/',
    title: "Best Photo Sharing App for Events (Free & Paid): How to Choose | Albums.ink",
    desc: "The best photo sharing app for events: free vs paid options, apps vs QR code albums, what guests need, photo quality, privacy and price. A practical guide.",
    ld: [faq([["What is the best photo sharing app for events?", "The one guests actually use: no download, no account, works on iPhone and Android, with visibility control for the host. A QR code event album meets all of these."], ["Is there a free photo sharing app for events?", "Google Photos, iCloud and shared folders are free, but they often need accounts or exclude Android or iPhone users. Free tiers of event apps are usually limited."], ["Do guests need to download an app?", "Not with a QR album: guests scan the code and upload from the phone browser."], ["Can I hide photos from other guests?", "Yes, on Albums you can hide any photo and choose who sees each one."], ["How long are event photos stored?", "An event (QR) album on Albums keeps them for 6 months from the first upload, with an option to extend; regular albums have no time limit. You can download everything as a ZIP at any time."]]), article("Best photo sharing app for events: free and paid options compared", '/guides/best-photo-sharing-app-for-events/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },  'guides/wedding-slideshow/index.html': {
    og: 'events',
    path: '/guides/wedding-slideshow/',
    title: "Photo Slideshow for a Wedding Reception: Ideas, Length & Music | Albums.ink",
    desc: "How to make a photo slideshow for a wedding reception: how many photos, ideal length, music, structure, free tools and how to collect guest photos for it.",
    ld: [faq([["How long should a wedding slideshow be?", "About 6–8 minutes, or one to two songs. More than ten minutes usually loses the room."], ["How many photos should a wedding slideshow have?", "Allow 5–7 seconds per photo: around 30–35 photos for 3 minutes and 60–80 for 6–8 minutes."], ["When should the slideshow be played at the reception?", "After dinner or just before the first dance works best for the story slideshow. A thank-you slideshow of guest photos fits a day-after brunch or a message to guests."], ["How do I get guests' photos for a slideshow?", "Use an event album. Guests scan a QR code and upload from the browser; you download everything as a ZIP and add the photos to your slideshow."], ["What is the best free way to make a wedding slideshow?", "Google Photos, iMovie, Canva or PowerPoint all work. Export as MP4 and test it at the venue."]]), article("Photo Slideshow for a Wedding Reception: Ideas, Length and Music", '/guides/wedding-slideshow/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },  'guides/group-photo-sharing/index.html': {
    og: 'events',
    path: '/guides/group-photo-sharing/',
    title: "Easy Way to Share Photos With a Group (Trips, Teams, Parties) | Albums.ink",
    desc: "The easiest ways to share photos with a group: group chats, cloud albums, shared folders and QR albums compared, with everyone's photos in one place.",
    ld: [faq([["What is the easiest way to share photos with a group?", "A single album with one link that anyone can open in the browser and upload to without an app or account. It works for iPhone and Android and keeps everything in one place."], ["How do I share photos with a group of iPhone and Android users?", "Use a browser-based link or QR album, or a cloud album that everyone can access. iCloud Shared Albums do not let Android users add photos."], ["Do group chats reduce photo quality?", "Usually yes. Most messaging apps compress photos, so for prints and keepsakes an album that stores full-size images is better."], ["Can I control who sees the group photos?", "Yes. With Albums you can keep the album private, choose who sees each photo, and hide any photo."], ["How long are the photos stored?", "An event (QR) album on Albums keeps them for 6 months from the first upload, with an option to extend; regular albums have no time limit. You can download everything as a ZIP at any time."]]), article("Easy Way to Share Photos With a Group: Trips, Teams and Parties", '/guides/group-photo-sharing/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },  'guides/christmas-party-photo-booth-ideas/index.html': {
    og: 'events',
    path: '/guides/christmas-party-photo-booth-ideas/',
    title: "Christmas Party Photo Booth Ideas: Backdrops, Props & Sharing | Albums.ink",
    desc: "Christmas party photo booth ideas: DIY backdrops, props, lighting, office and family setups, plus an easy way to collect every guest's photos in one album.",
    ld: [faq([["How do I make a cheap Christmas photo booth?", "Use fairy lights behind a white curtain or wrapping paper on a wall, add homemade props and a phone on a stand. Good front light matters more than expensive decorations."], ["What props do I need for a Christmas photo booth?", "Santa hats, antlers, elf ears, speech bubbles and a sign with the party name and date. Ten to fifteen props are enough for about fifty guests."], ["How do guests share photos from the booth?", "Put a QR code at the booth that opens an event album. Guests upload from the phone browser without an app or account."], ["Can guests see each other's photo booth pictures?", "Yes, in the shared album. You can hide any photo and choose who sees each one."], ["How long are the party photos stored?", "An event (QR) album on Albums keeps them for 6 months from the first upload, with an option to extend; regular albums have no time limit. You can download everything as a ZIP at any time."]]), article("Christmas Party Photo Booth Ideas: Backdrops, Props and Sharing", '/guides/christmas-party-photo-booth-ideas/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },  'guides/wedding-hashtag-ideas/index.html': {
    og: 'events',
    path: '/guides/wedding-hashtag-ideas/',
    title: "Wedding Hashtag Ideas: 40+ Examples & How to Make Your Own | Albums.ink",
    desc: "Wedding hashtag ideas with formulas and examples, how to check one is unique, where to display it, and why a hashtag alone won't collect all your photos.",
    ld: [faq([["How do I create a wedding hashtag?", "Combine your names or surname with a word like \"weds\", \"ever after\" or the year. Keep it short, capitalise each word and check that it is not already used."], ["Should a wedding hashtag include the year?", "Adding the year is the easiest way to make a common hashtag unique, for example #AnnaAndTom2027."], ["Where should I put the wedding hashtag?", "On the invitations, the wedding website, a sign at the entrance, table cards and the reception screen."], ["Will a hashtag collect all our wedding photos?", "No. Photos from private accounts and guests who do not post will be missing. A QR album collects photos from everyone."], ["How long does Albums keep the photos?", "An event (QR) album on Albums keeps them for 6 months from the first upload, with an option to extend; regular albums have no time limit. You can download everything as a ZIP at any time."]]), article("Wedding Hashtag Ideas: Examples, Formulas and How to Make Your Own", '/guides/wedding-hashtag-ideas/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },  'guides/retirement-party-photo-ideas/index.html': {
    og: 'events',
    path: '/guides/retirement-party-photo-ideas/',
    title: "Retirement Party Photo Ideas: Memory Wall, Props & Gifts | Albums.ink",
    desc: "Retirement party photo ideas: a career memory wall, then-and-now photos, props, group photos, a photo book gift and how to collect colleagues' photos.",
    ld: [faq([["What photos should I collect for a retirement party?", "Early career photos, team trips, office celebrations, funny moments and a few family photos. Start collecting two to three weeks before the party."], ["How do I collect photos from colleagues in other offices?", "Send one album link. Colleagues upload from the phone or computer browser without an app or account, wherever they are."], ["What is a good photo gift for a retiree?", "A photo book with chapters for each period of the career, a framed team collage or a slideshow made from the album."], ["Can I keep some photos private?", "Yes. With Albums you can hide any photo and choose who sees each one."], ["How long are the photos stored?", "An event (QR) album on Albums keeps them for 6 months from the first upload, with an option to extend; regular albums have no time limit. You can download everything as a ZIP at any time."]]), article("Retirement Party Photo Ideas: Memory Wall, Props and Gifts", '/guides/retirement-party-photo-ideas/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },  'guides/first-birthday-photo-ideas/index.html': {
    og: 'events',
    path: '/guides/first-birthday-photo-ideas/',
    title: "First Birthday Photo Ideas: Cake Smash, Monthly Collage & More | Albums.ink",
    desc: "First birthday photo ideas: cake smash, a 12-month collage, milestone boards, family photos, decorations and how to collect every guest's photos.",
    ld: [faq([["What photos should I take at a first birthday party?", "The cake smash, the candles, a whole-family photo, photos with grandparents and siblings, a milestone board and details like decorations and the cake."], ["What is a cake smash?", "A small cake just for the baby to explore with their hands. It makes funny, colorful photos; keep it short and have a bath ready after."], ["How do I make a first year photo collage?", "Pick one photo from each of the 12 months, ideally in the same spot or with the same toy, and print them together as a collage or a photo line."], ["How do I get photos from all the guests?", "Share one album link or QR code. Guests upload from the phone browser without an app or account, and you download everything as a ZIP."], ["How long are the photos kept?", "An event (QR) album on Albums keeps them for 6 months from the first upload, with an option to extend; regular albums have no time limit. You can download everything as a ZIP at any time."]]), article("First Birthday Photo Ideas: Cake Smash, Monthly Collage and Family Photos", '/guides/first-birthday-photo-ideas/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/add-voice-to-photos/index.html': {
    og: 'home',
    path: '/guides/add-voice-to-photos/',
    title: "How to Add Voice to Photos Online for Free | Albums.ink",
    desc: "How to add voice to photos online for free: voice notes next to photos, narrated story albums with chapters, and ideas for family, travel and gifts.",
    ld: [faq([["How can I add voice to photos online for free?", "Create a story album on Albums.ink, upload photos and add voice notes next to them, plus narration for each chapter. It is free."], ["Do I need to make a video to add audio to photos?", "No. On Albums.ink voice notes sit next to photos in the album, so there is nothing to edit or export."], ["Can I record voice on my phone?", "Yes. Record voice notes or narration right in the phone browser, or upload an audio file. There is no app to install."], ["Can I keep narrated family albums private?", "Yes. Make the album private or friends only and add exceptions for specific relatives."], ["Does Albums.ink use AI voices?", "No. Albums.ink has no AI features; the voices are the ones you record."]]), article("How to Add Voice to Photos Online: Narrated Albums for Free", '/guides/add-voice-to-photos/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/baby-photo-sharing/index.html': {
    og: 'home',
    path: '/guides/baby-photo-sharing/',
    title: "Baby Photo Sharing Without an App: Free and Private | Albums.ink",
    desc: "Baby photo sharing that stays private and free: share newborn photos with grandparents, keep them off public feeds, and organize the first year by month.",
    ld: [faq([["What is the best private way to share baby photos?", "A private album shared only with invited family. On Albums.ink baby albums can be private or friends only, with exceptions per person and per photo."], ["Do grandparents need an app?", "No. Albums.ink is a website; they sign in with Google in the browser."], ["Is baby photo sharing on Albums.ink free?", "Yes. Unlimited albums and posts are free, and your albums are stored as long as you need them."], ["Can both parents upload?", "Yes. Add your partner as co-author; free albums allow one co-author from your friends."], ["Can I stop people from taking screenshots?", "No service can fully prevent screenshots. Share only with people you trust and keep albums private."]]), article("Baby Photo Sharing: A Free, Private Way to Share Your Baby's Photos", '/guides/baby-photo-sharing/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/digital-scrapbook/index.html': {
    og: 'home',
    path: '/guides/digital-scrapbook/',
    title: "Digital Scrapbook Online: Free Scrapbooking Website Ideas | Albums.ink",
    desc: "Make a digital scrapbook online for free: what scrapbooking websites offer, how to build a story with photos, voice notes and chapters, and page ideas.",
    ld: [faq([["What is the best free digital scrapbook website?", "For decorated pages, template-based tools. For story-first scrapbooks with photos, videos, voice notes and chapters, Albums.ink is free with unlimited albums."], ["Can I add tickets and notes to a digital scrapbook?", "Yes. Photograph or scan them and upload them as photos, with a caption."], ["Can I add voice to my scrapbook?", "Yes. Add voice notes next to photos and narration for chapters."], ["Can I make a scrapbook with someone else?", "Yes. Each free album can have one co-author from your friends. Pro allows up to 10."], ["Can I print my digital scrapbook?", "Albums.ink has no printing service, but you can download the whole album and print it elsewhere."]]), article("Digital Scrapbook Online: Free Scrapbooking With Photos, Words and Voice", '/guides/digital-scrapbook/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/facebook-alternatives-for-families/index.html': {
    og: 'home',
    path: '/guides/facebook-alternatives-for-families/',
    title: "Facebook Alternatives for Families: Private and Free | Albums.ink",
    desc: "Facebook alternatives for families compared honestly: group chats, family apps, cloud albums and Albums.ink, a free album network with real privacy.",
    ld: [faq([["What is a good Facebook alternative for families?", "For private family albums with a feed and comments, Albums.ink is free and runs in any browser. For messaging, a group chat app."], ["Can I move my Facebook photos to Albums.ink?", "Yes. Download your photos from Facebook, then upload them to albums on Albums.ink."], ["Does Albums.ink have groups or messaging?", "No. It focuses on albums, posts, comments, likes and bookmarks."], ["Is Albums.ink private?", "Each album can be public, friends only or private, with exceptions per person and visibility per photo."], ["Is it free?", "Yes. Unlimited albums and posts are free, and your albums are stored as long as you need them."]]), article("Facebook Alternatives for Families: Where to Share Family Life Privately", '/guides/facebook-alternatives-for-families/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/family-history-stories/index.html': {
    og: 'home',
    path: '/guides/family-history-stories/',
    title: "Family History Stories: Save Them With Photos and Voice | Albums.ink",
    desc: "How to collect and save family history stories: interview prompts, old photos with grandparents' voice narration, chapters by generation, private sharing.",
    ld: [faq([["How do I collect family history stories?", "Sit with older relatives, show them old photos, ask open questions and record short voice notes about each photo."], ["How can I save old family photos with stories?", "Scan the photos and put them in story albums on Albums.ink with captions, voice notes and narration."], ["Can relatives add their own photos and stories?", "Yes. Add a co-author to an album, and relatives can comment with details and corrections."], ["Is the family archive private?", "It can be. Set albums to private or friends only and add exceptions for specific relatives."], ["Is Albums.ink a genealogy site?", "No. It has no family trees or record search; it focuses on photos, stories and voices."]]), article("Family History Stories: How to Save Them With Photos and Voices", '/guides/family-history-stories/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/flickr-alternatives/index.html': {
    og: 'home',
    path: '/guides/flickr-alternatives/',
    title: "Free Flickr Alternatives for Sharing Photos in 2026 | Albums.ink",
    desc: "Free Flickr alternatives compared honestly: what Flickr's free plan allows, portfolio sites, cloud albums and Albums.ink for unlimited free albums.",
    ld: [faq([["What is the best free Flickr alternative?", "For unlimited free albums with privacy and a social feed, Albums.ink. For full-resolution archives and photography groups, Flickr Pro is still strong."], ["How many photos can I upload to Flickr for free?", "Flickr's help center says free accounts can upload up to 1,000 items, with up to 50 non-public."], ["Is Albums.ink free without limits?", "Albums and posts are unlimited and yours as long as you need them on the free plan. Free photos are saved at up to 2048 px."], ["Can I keep many albums private on Albums.ink?", "Yes. There is no cap on private or friends-only albums."], ["Does Albums.ink have groups like Flickr?", "No. It has friends, follows, a feed, likes, comments and bookmarks."]]), article("Free Flickr Alternatives: Where to Share Photos Without Limits", '/guides/flickr-alternatives/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/google-photos-alternative/index.html': {
    og: 'home',
    path: '/guides/google-photos-alternative/',
    title: "Free Google Photos Alternative for Sharing Albums | Albums.ink",
    desc: "Looking for a free Google Photos alternative? Compare options for storage and sharing, and see when a social photo album like Albums.ink fits better.",
    ld: [faq([["What is the best free alternative to Google Photos?", "For backup, another cloud such as iCloud or OneDrive, or self-hosted Immich. For shareable albums with stories and friends, Albums.ink is free with unlimited albums."], ["Does Albums.ink back up my phone like Google Photos?", "No. It has no app and no automatic sync. You upload the photos and videos you choose."], ["Is Albums.ink really free?", "Yes. Unlimited albums and posts are free, and your albums are stored as long as you need them. Pro adds 4K photos, bigger videos, more co-authors and stats."], ["Can I keep albums private?", "Yes. Each album can be public, friends only or private, with exceptions for specific people and visibility per photo."], ["Does Albums.ink have face recognition or AI search?", "No. Albums.ink does not use AI or face recognition."]]), article("Free Google Photos Alternative: Albums You Can Share, Tell and Keep", '/guides/google-photos-alternative/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/how-to-make-a-photo-story/index.html': {
    og: 'home',
    path: '/guides/how-to-make-a-photo-story/',
    title: "How to Make a Photo Story With Photos, Video and Voice | Albums.ink",
    desc: "How to make a photo story that people watch to the end: pick photos, build a story arc, add chapters and voice narration, and share it for free.",
    ld: [faq([["How do I make a photo story?", "Decide the story in one sentence, choose 15 to 40 photos, order them with a beginning, middle and end, add captions and voice, then share."], ["How many photos should a photo story have?", "Usually 15 to 40 for a short story. Use chapters for longer ones."], ["Can I add narration to a photo story?", "Yes. On Albums.ink you can add voice notes next to photos and voice narration to story albums."], ["Do photo stories on Albums.ink disappear?", "No. Story albums stay until you delete them."], ["Can I make a photo story on my phone?", "Yes, in the phone browser. There is no app to install."]]), article("How to Make a Photo Story: From a Pile of Photos to a Story People Follow", '/guides/how-to-make-a-photo-story/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/instagram-alternative/index.html': {
    og: 'home',
    path: '/guides/instagram-alternative/',
    title: "Instagram Alternative for Sharing Photos With Friends | Albums.ink",
    desc: "An Instagram alternative for adults who want to share photos with real friends: albums, stories with voice, a calm feed and real privacy.",
    ld: [faq([["What is a good Instagram alternative for adults?", "If you want to share with people you know rather than strangers, an album-based social network like Albums.ink, with friends, a feed and fine privacy, is a calm alternative."], ["Is Albums.ink free?", "Yes. Unlimited albums and posts are free, and your albums are stored as long as you need them. Pro is optional."], ["Does Albums.ink have an app?", "No. It is a website that works in any phone or computer browser."], ["Do stories disappear on Albums.ink?", "No. Story albums with chapters and voice narration stay until you delete them."], ["Can I control who sees each photo?", "Yes. Set an album to public, friends only or private, add exceptions for specific people, and change visibility per photo or video."]]), article("Instagram Alternative: Share Photos With Friends, Not With an Algorithm", '/guides/instagram-alternative/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/online-photo-album-free/index.html': {
    og: 'home',
    path: '/guides/online-photo-album-free/',
    title: "Online Photo Album Free: Create and Share Albums | Albums.ink",
    desc: "Create an online photo album for free: unlimited albums, chapters, voice notes, privacy per photo and a share link with a cover preview.",
    ld: [faq([["Where can I make an online photo album for free?", "On Albums.ink you can create unlimited online photo albums for free, stored as long as you need, with chapters, voice notes and privacy settings."], ["Is there a limit on photos?", "No limit on albums and posts on the free plan. Free photos are saved at up to 2048 px on the long side."], ["Can I share my album with people who don't have an account?", "Public albums can be viewed by anyone with the link. For private or friends-only albums, viewers sign in with Google."], ["Can I download my online album?", "Yes. You can download a whole album at any time."], ["Can I print a photo book from Albums.ink?", "There is no printing service, but you can download the album and print anywhere."]]), article("Online Photo Album Free: Create, Organize and Share Albums", '/guides/online-photo-album-free/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/photo-blog/index.html': {
    og: 'home',
    path: '/guides/photo-blog/',
    title: "Free Photo Blog Sites: Start a Photo Blog in 2026 | Albums.ink",
    desc: "Free photo blog sites compared: blogging platforms, portfolios and Albums.ink, where every album is a post with voice notes, followers and comments.",
    ld: [faq([["What is the best free photo blog site?", "It depends on your goal. For a photo-first blog with followers and comments, Albums.ink is free and unlimited. For full design control, a blogging platform."], ["Can I start a photo blog for free?", "Yes. On Albums.ink, albums and posts are free and unlimited, and they are stored as long as you need them."], ["Can people follow my photo blog?", "Yes. People can follow you and see your new albums in their feed."], ["Can I use my own domain?", "No. Albums.ink does not support custom domains; each album has a share link."], ["What image quality do I get?", "Free photos are stored at up to 2048 px. Pro keeps photos up to 4K."]]), article("Free Photo Blog Sites: How to Start a Photo Blog People Follow", '/guides/photo-blog/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/photo-diary/index.html': {
    og: 'home',
    path: '/guides/photo-diary/',
    title: "Photo Diary Online Free: Keep a Daily Photo Journal | Albums.ink",
    desc: "Keep a photo diary online for free: daily or weekly entries with photos, videos and voice notes, monthly chapters, private by default. Ideas and prompts.",
    ld: [faq([["Is there a free photo diary online?", "Yes. On Albums.ink you can keep a photo diary in a free story album with monthly chapters, captions and voice notes."], ["Do I need a photo diary app?", "No. Albums.ink works in your phone browser; you can add it to your home screen."], ["Can my photo diary be private?", "Yes. Set the album to private, or share it only with chosen people."], ["Can I add voice to diary entries?", "Yes. Add a voice note next to any photo."], ["How long is my diary kept?", "Your albums are stored as long as you need them, and you can download them any time."]]), article("Photo Diary Online: A Free Daily Photo Journal You Will Actually Keep", '/guides/photo-diary/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/private-photo-sharing-for-couples/index.html': {
    og: 'home',
    path: '/guides/private-photo-sharing-for-couples/',
    title: "Private Photo Sharing for Couples: A Free Shared Album | Albums.ink",
    desc: "Private photo sharing for couples: one shared album you both add to, private by default, with voice notes and chapters for your story. Free, no app.",
    ld: [faq([["What is the best private photo sharing for couples?", "A shared album you both can add to, private by default. On Albums.ink each free album can have one co-author, perfect for a couple."], ["Can my partner add photos to my album?", "Yes. Add your partner as a friend and then as co-author of the album."], ["Is it private?", "Set the album to private and only you and your co-author see it. You can add exceptions for specific people later."], ["Is it free?", "Yes. Unlimited albums and posts are free, and your albums are stored as long as you need them."], ["Do we need an app?", "No. Albums.ink works in any browser on iPhone, Android and computers."]]), article("Private Photo Sharing for Couples: One Shared Album for Your Story", '/guides/private-photo-sharing-for-couples/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/private-photo-sharing-for-family/index.html': {
    og: 'home',
    path: '/guides/private-photo-sharing-for-family/',
    title: "Private Photo Sharing for Family: Free and Simple | Albums.ink",
    desc: "Private photo sharing for family, explained: compare group chats, cloud albums and private albums, and set up free family albums only relatives can see.",
    ld: [faq([["What is the best way to share photos privately with family?", "Use albums with real privacy settings. On Albums.ink each album can be private or friends only, with exceptions for specific relatives and visibility per photo."], ["Do family members need an app?", "No. Albums.ink is a website. Relatives sign in with Google in their phone or computer browser."], ["Is private family photo sharing free?", "Yes. Unlimited albums and posts are free on Albums.ink, and they are stored as long as you need them."], ["Can two parents add photos to the same album?", "Yes. Each free album can have one co-author from your friends. Pro allows up to 10."], ["Can I hide some photos from certain relatives?", "Yes. Use per-person exceptions on the album and per-file visibility for individual photos or videos."]]), article("Private Photo Sharing for Family: A Free, Simple Setup", '/guides/private-photo-sharing-for-family/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/private-social-network-for-family/index.html': {
    og: 'home',
    path: '/guides/private-social-network-for-family/',
    title: "Private Social Network for Family: Free, No Ads | Albums.ink",
    desc: "A private social network for family: what it needs, options compared, and how to set up a free family space with albums, feed, comments and privacy.",
    ld: [faq([["What is the best private social network for family?", "Look for invite-only sharing, a feed, comments, albums and fine privacy. Albums.ink offers all of these for free on the web."], ["Do relatives need to install an app?", "No. Albums.ink is a website; relatives sign in with Google in their browser."], ["Can I keep kids' photos away from strangers?", "Yes. Use friends-only or private albums, add exceptions only for trusted relatives and hide individual photos if needed."], ["Is there a cost?", "Unlimited albums and posts are free, and your albums are stored as long as you need them. Pro is optional."], ["Can relatives in other countries use it?", "Yes. It works in any browser and the interface is available in 12 languages."]]), article("Private Social Network for Family: A Free Space Just for Your People", '/guides/private-social-network-for-family/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/share-photo-album-with-link/index.html': {
    og: 'home',
    path: '/guides/share-photo-album-with-link/',
    title: "How to Share a Photo Album With a Link (Free) | Albums.ink",
    desc: "How to share a photo album with a link from Google Photos, iCloud and Albums.ink: privacy, previews, who can open it and how to stop sharing later.",
    ld: [faq([["How do I share a photo album with a link?", "Create an album, choose its privacy, copy the share link and send it. On Albums.ink the link shows a cover preview in chats."], ["Can anyone with the link see my album?", "Only if it is public. Friends-only and private albums on Albums.ink are visible only to friends or to the people you add as exceptions."], ["Can I share an album with Android and iPhone users?", "Yes. Albums.ink works in any browser, so the link opens on iPhone, Android and computers."], ["Can I stop sharing later?", "Yes. Change the album to private, remove exceptions or hide individual photos."], ["Is sharing albums by link free?", "Yes. Unlimited albums and link sharing are free on Albums.ink."]]), article("How to Share a Photo Album With a Link: Free, Private and Easy to Open", '/guides/share-photo-album-with-link/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/share-vacation-photos-with-friends/index.html': {
    og: 'home',
    path: '/guides/share-vacation-photos-with-friends/',
    title: "Best Way to Share Vacation Photos With Friends | Albums.ink",
    desc: "The best way to share vacation photos with friends: one album everyone sees, a co-author who adds photos, chapters by day and privacy you control. Free.",
    ld: [faq([["What is the best way to share vacation photos with friends?", "Create one shared album, add a co-author, organize photos by day and share the link in your group chat. Albums.ink does this for free."], ["Can friends on iPhone and Android see the album?", "Yes. Albums.ink works in any browser."], ["Can more than one person add photos?", "Yes. Free albums allow one co-author from your friends; Pro allows up to 10."], ["Can I keep some photos private?", "Yes. Hide individual photos or videos, or make the album private with exceptions."], ["Does it keep full quality?", "Free photos are stored at up to 2048 px. Pro keeps photos up to 4K."]]), article("The Best Way to Share Vacation Photos With Friends (and Actually See Them Later)", '/guides/share-vacation-photos-with-friends/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/travel-diary-online/index.html': {
    og: 'home',
    path: '/guides/travel-diary-online/',
    title: "Travel Diary Online Free: Keep a Trip Journal With Photos | Albums.ink",
    desc: "Keep a travel diary online for free: daily entries with photos, videos and voice notes, chapters per day, privacy for family and a link to share.",
    ld: [faq([["How do I keep a travel diary online for free?", "Create a story album on Albums.ink with one chapter per day, add photos, short text and voice notes each evening, and share it with family."], ["Can family follow my travel diary while I travel?", "Yes. Share the link or add them as friends; new chapters appear in their feed."], ["Can I keep my travel diary private?", "Yes. Make it private, add exceptions for specific people or hide individual photos."], ["Does it work without internet?", "Uploading needs internet. Write notes offline and add them when you have Wi-Fi."], ["Is there a travel diary app?", "Albums.ink has no app; it works in any phone browser."]]), article("Travel Diary Online: A Free Trip Journal With Photos and Your Voice", '/guides/travel-diary-online/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/travel-photo-album-online/index.html': {
    og: 'home',
    path: '/guides/travel-photo-album-online/',
    title: "Travel Photo Album Online: Free Trip Albums With Stories | Albums.ink",
    desc: "Make a travel photo album online for free: chapters by day, voice notes from the road, privacy for friends and family, and a link that shows a cover.",
    ld: [faq([["How do I make a travel photo album online for free?", "Create an album on Albums.ink, upload your best photos and videos, split them into chapters, add captions and voice notes, then share it by link."], ["Can I keep my travel album private?", "Yes. Make it private or friends only, add exceptions for specific people and hide individual photos."], ["Can my travel partner add photos?", "Yes. Each free album can have one co-author from your friends. Pro allows up to 10."], ["Can I print a travel photo book from it?", "Albums.ink has no printing service, but you can download the whole album and use any print service."], ["How long is my travel album stored?", "Your albums are stored as long as you need them."]]), article("Travel Photo Album Online: Turn Every Trip Into a Story Worth Sharing", '/guides/travel-photo-album-online/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/free-photo-storage/index.html': {
    og: 'home',
    path: '/guides/free-photo-storage/',
    title: "Free Photo Storage Online: Best Free Places to Keep Photos | Albums.ink",
    desc: "Free photo storage online compared: Google Photos, iCloud, Flickr and Albums.ink. What is really free, what gets compressed and how long photos stay.",
    ld: [faq([["What is the best free photo storage online?", "It depends on the job. For automatic backup, your phone's cloud within its free quota. For albums you keep and share, a service with unlimited free albums like Albums.ink."], ["Is there unlimited free photo storage?", "Some services offer unlimited uploads with compression. Albums.ink lets you create unlimited albums and posts for free, with photos saved at up to 2048 px."], ["How long are my photos kept?", "Policies differ, so read them. On Albums.ink your albums are stored as long as you need them."], ["Can I download my photos later?", "Yes. On Albums.ink you can download a whole album at any time."], ["Does Albums.ink back up my phone automatically?", "No. There is no app and no automatic sync; you upload the photos you choose from the browser."]]), article("Free Photo Storage Online: Where to Keep and Share Your Best Photos", '/guides/free-photo-storage/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/photo-dump-ideas/index.html': {
    og: 'home',
    path: '/guides/photo-dump-ideas/',
    title: "Photo Dump Ideas: What It Means and How to Make One | Albums.ink",
    desc: "What a photo dump is, ideas for a good one, how many photos to use, how to order them and where to keep the full set in a free album you can share by link.",
    ld: [faq([["What does photo dump mean?", "A photo dump is a casual set of photos from the same period, such as a weekend or a trip, posted together as a carousel or album."], ["How many photos should a photo dump have?", "Eight to ten photos is a good range. More is fine if every photo adds something different."], ["Can I keep a photo dump private?", "Yes. On Albums.ink an album can be public, friends only or private, with exceptions for specific people."], ["Do I need an app to make a photo dump album?", "No. Albums.ink runs in your browser. Sign in with Google, upload photos and share a link."], ["Can I add sound to a photo dump?", "Yes. You can record voice notes in the browser and attach them to photos, then play the album as a slideshow with narration."]]), article("Photo Dump Ideas: What It Means and How to Make One", '/guides/photo-dump-ideas/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/how-to-make-a-photo-essay/index.html': {
    og: 'home',
    path: '/guides/how-to-make-a-photo-essay/',
    title: "How to Make a Photo Essay: Steps, Structure and Examples | Albums.ink",
    desc: "How to make a photo essay: pick a topic, plan the story, choose 8–15 photos, write captions, add voice and publish it online free with a link to share.",
    ld: [faq([["What is a photo essay?", "A photo essay is a sequence of photos, usually with short captions, that tells a story or explores a topic."], ["How many photos should a photo essay have?", "Most short photo essays use 8 to 15 photos. Longer ones can use up to about 25, grouped into chapters."], ["Can I make a photo essay online for free?", "Yes. On Albums.ink you can create a free story album with chapters, captions and voice notes, and share it by link."], ["Can I add narration to my photo essay?", "Yes. Record voice notes in your browser and play the album as a slideshow with narration."], ["Who can see my photo essay?", "You choose: public, friends only or private. A public album can be opened by link without signing in."]]), article("How to Make a Photo Essay: Steps, Structure and Examples", '/guides/how-to-make-a-photo-essay/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/year-in-review-photo-album/index.html': {
    og: 'home',
    path: '/guides/year-in-review-photo-album/',
    title: "Year in Review Photos: How to Make a Photo Album of Your Year | Albums.ink",
    desc: "Make a year in review photo album: pick the best photos of 12 months, group them in chapters, add captions and voice, and share it free with a link.",
    ld: [faq([["How do I make a year in review photo album?", "Gather your photos, shortlist five to ten per month, group them into chapters, add captions and share the album by link."], ["Is there a free way to make a year in review?", "Yes. A free Albums.ink story album supports chapters, captions, voice notes and sharing by link."], ["How many photos should a year in review have?", "Around 60 to 120 photos works well, or just 12 if you make a top-12 version with one photo per month."], ["Can my family add their photos?", "Yes. Free albums allow one co-author, and Pro allows up to 10."], ["Can I keep my year in review private?", "Yes. Set the album to private or friends only, or share a public link with whoever you choose."]]), article("Year in Review Photos: How to Make a Photo Album of Your Year", '/guides/year-in-review-photo-album/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/pet-photo-album-online/index.html': {
    og: 'home',
    path: '/guides/pet-photo-album-online/',
    title: "Pet Photo Album Online: A Free Album for Your Dog or Cat | Albums.ink",
    desc: "Create a pet photo album online for free: organise your dog or cat photos by year, add captions, voice notes and videos, and share it with family by link.",
    ld: [faq([["How do I make a pet photo album online?", "Create an album, add chapters by year or theme, upload photos and videos, write captions and share the link."], ["Is a pet photo album free?", "Yes. Albums.ink has a free plan with albums, chapters, captions and voice notes. Pro costs $9.99 per month for 4K and more co-authors."], ["Can I add videos of my pet?", "Yes. Free videos can be up to 50 MB per file; Pro allows up to 500 MB."], ["Can my family add their photos?", "Yes. Free albums allow one co-author, and Pro allows up to 10."], ["Can I keep the album private?", "Yes. Choose private or friends only, or share a public link that opens without signing in."]]), article("Pet Photo Album Online: A Free Album for Your Dog or Cat", '/guides/pet-photo-album-online/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/wedding-photo-scavenger-hunt/index.html': {
    og: 'events',
    path: '/guides/wedding-photo-scavenger-hunt/',
    title: "Wedding Photo Scavenger Hunt: 30 Ideas + QR Code Album | Albums.ink",
    desc: "A wedding photo scavenger hunt (photo challenge) for guests: 30 prompts, how to run it with table cards and a QR code, and how to collect every photo.",
    ld: [faq([["What is a wedding photo scavenger hunt?", "A game where guests complete a list of photo prompts during the wedding and upload their photos to a shared album."], ["How many prompts should I include?", "Ten to fifteen is a good number. More feels like a task, and fewer gives guests too little to do."], ["How do guests submit their photos?", "They scan a QR code on the table cards and upload from their phone browser. No app and no account are needed."], ["Can I approve photos before others see them?", "Yes. Turn on holding for guest photos and each one waits for your approval before anyone else can see it."], ["How long are the photos stored?", "Event albums are stored for 6 months from the first upload, and you can extend the storage. You can also download everything as a ZIP."]]), article("Wedding Photo Scavenger Hunt: 30 Ideas and a QR Code Album", '/guides/wedding-photo-scavenger-hunt/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/birthday-party-photo-sharing/index.html': {
    og: 'events',
    path: '/guides/birthday-party-photo-sharing/',
    title: "Birthday Party Photo Sharing: QR Code Album for Guests | Albums.ink",
    desc: "Share birthday party photos easily: a QR code album where guests upload photos and videos from their phone, no app. How it works, tips, prices, mistakes.",
    ld: [faq([["How do I share photos from a birthday party?", "Create an event album with a QR code. Guests scan it and upload photos and videos from their phone browser, and you download everything as a ZIP."], ["Do guests need to install an app?", "No. They scan the QR code and upload from the browser, with no app and no account."], ["Can I approve photos before other guests see them?", "Yes. With Hold guest photos, each photo waits for your approval before anyone else can see it."], ["How long are the photos stored?", "Event albums are stored for 6 months from the first upload, and you can extend them. You can download everything as a ZIP at any time."], ["How much does it cost?", "From $39.99 one time for the Small album. Guests never pay."]]), article("Birthday Party Photo Sharing: A QR Code Album for Your Guests", '/guides/birthday-party-photo-sharing/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/company-party-photo-sharing/index.html': {
    og: 'events',
    path: '/guides/company-party-photo-sharing/',
    title: "Company Party Photo Sharing: Collect Photos from Your Team | Albums.ink",
    desc: "How to share photos from a company party or team event: QR code album, no app or sign-up, owner approval before photos are visible, ZIP download, prices.",
    ld: [faq([["How do I share photos from a company party?", "Create an event album with a QR code. Colleagues scan it and upload from their phone browser; you download everything as a ZIP."], ["Do colleagues need an account or app?", "No. They scan the code and upload from the browser without registering."], ["Can I check photos before the team sees them?", "Yes. With Hold guest photos, each photo waits for your approval before anyone else can see it."], ["How long are the photos stored?", "Event albums are stored for 6 months from the first upload, and the storage can be extended. You can download everything as a ZIP."], ["How much does it cost?", "Event albums are a one-time purchase from $39.99. Guests never pay."]]), article("Company Party Photo Sharing: Collect Photos from Your Team in One Album", '/guides/company-party-photo-sharing/')],
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
    ld: [faq([["What is the easiest way to collect photos from event guests?", "Print a QR code that opens an upload page in the browser. Guests scan and upload during the event with no app or account, and everything lands in one album."], ["How do I collect photos from guests for free?", "You can share an editable Google Drive or Dropbox folder link, but many guests will need an account, and there is no approval."], ["Can guests upload videos too?", "Yes, guests can upload both photos and videos."], ["How do I keep inappropriate photos out of a corporate event album?", "Turn on approval so every upload waits for review, and hide any photo you don't want visible."], ["How long can guests keep uploading?", "The upload page stays open after the event; event album storage runs 6 months from the first upload and can be extended."]]), article("How to collect photos from event guests with one QR code", '/guides/how-to-collect-photos-from-event-guests/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/baby-shower-photo-album/index.html': {
    og: 'events',
    path: '/guides/baby-shower-photo-album/',
    title: "Baby Shower Photo Album: Collect Guest Photos + Photo Ideas | Albums.ink",
    desc: "How to make a baby shower photo album from guest photos with one QR code: no app, sign wording, baby shower photo ideas and games, and a keepsake album for the baby.",
    ld: [faq([["How do I collect photos from baby shower guests?", "Place a QR code at the gift table and on each table. Guests scan it and upload photos from the phone browser into one album, with no app or sign-up."], ["What should be in a baby shower photo album?", "Decorations, candid photos of the parents-to-be, gift opening, games, family generations, guest messages, the cake and a group photo."], ["What are good baby shower photo ideas?", "The bump with each grandparent-to-be, guests holding tiny outfits, the parents reading cards, a photo scavenger hunt and a baby photo guessing game."], ["Can relatives who can't attend see the photos?", "Yes. Send them the album link and they can browse the album and add their own photos and greetings."], ["Can I keep the baby shower album private?", "Yes. Keep the album hidden so only people with the link can open it, and turn on approval to check uploads first."]]), article("Baby shower photo album: collect every guest photo with one QR code", '/guides/baby-shower-photo-album/')],
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
    desc: "Graduation party photo display ideas: memory table, photo board and a slideshow on a TV, plus how to collect every guest photo from the ceremony and grad party with one QR code.",
    ld: [faq([["What do you put on a graduation photo board?", "Photos from each school year grouped by stage, with captions and years, and the graduation photo in the centre."], ["How do I display photos at a graduation party?", "Use a photo board, a year-by-year timeline, a memory table, then-and-now pairs, or a slideshow of guest photos on a TV."], ["How do I collect old photos of the graduate from family?", "Send relatives an album link a few weeks before; they upload from the phone browser with no app, and you download what you need for printing."], ["How many photos do I need for a graduation photo board?", "Usually 30–60: a few from each year plus key milestones."], ["Can guests upload videos of the ceremony?", "Yes, guests can upload both photos and videos."]]), article("Graduation party photo display ideas (and how to collect every guest photo)", '/guides/graduation-party-photo-display-ideas/')],
    sitemap: { changefreq: 'monthly', priority: '0.7' },
  },
  'guides/memorial-photo-album/index.html': {
    og: 'events',
    path: '/guides/memorial-photo-album/',
    title: "Memorial Photo Album: Collect Photos of a Loved One from Family & Friends | Albums.ink",
    desc: "How to make a memorial photo album together: collect photos of a loved one from family and friends with a QR code, funeral photo display ideas, voice memories and an album to keep.",
    ld: [faq([["How do I collect photos of a loved one for a funeral?", "Create a private album and share its link with the funeral notice. Family and friends upload photos from the phone browser, and you download what you need for boards and a slideshow."], ["How many photos should be in a memorial slideshow?", "Around 40–80 photos for a 10–15 minute slideshow."], ["What can I display at a funeral besides photo boards?", "A timeline table with meaningful objects, a slideshow, a memory wall, memory cards on tables, or a slideshow of the album at a celebration of life."], ["Can the memorial album be private?", "Yes. Keep it hidden so only people with the link can open it, and turn on approval to review photos before they appear."], ["Can relatives keep adding photos later?", "Yes. Uploads stay open after the service, and storage can be extended."]]), article("Memorial photo album: gathering photos of a loved one from family and friends", '/guides/memorial-photo-album/')],
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
    ld: [faq([["Can Android users add photos to an iCloud shared album?", "No. Android users can view a public website link of an iCloud Shared Album but cannot upload."], ["What is the best shared photo album for iPhone and Android?", "For mixed groups and events, a browser-based QR album works on any phone without an app or account. Google Photos works if everyone has a Google account."], ["How do I share photos between iPhone and Android without an app?", "Use an album with a web upload page: share its link or QR code, and people upload from Safari or Chrome."], ["Does Google Photos work on iPhone?", "Yes, through the Google Photos app with a Google account."], ["Do shared albums reduce photo quality?", "Often. iCloud Shared Albums store reduced copies and chats compress heavily; Albums stores photos in up to 4K (3840 px on the long side)."]]), article("Shared photo album for iPhone and Android: what actually works", '/guides/shared-photo-album-iphone-android/')],
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
