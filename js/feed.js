// Главная: лента рекомендаций альбомов + режим поиска (?q=).
import { sb, currentProfile } from './sb.js';
import { CATEGORIES } from './config.js';
import {
  el, $, clear, mountShell, albumCard, skeletonGrid, signUrls, emptyState,
  composition, fmtCount, timeAgo, avatarImg, icon, playTriangle, t, catLabel, proSet,
} from './ui.js';
import { observeImpressions } from './stats.js';

const app = $('#app');
const PAGE = 24;

// Альбомы, скрытые ТОЛЬКО из ленты главной (все вкладки: «Для вас», «В тренде»,
// «Свежее» и категории). В профиле автора, по прямой ссылке и в поиске они
// остаются. Флага «не в ленту» в базе нет (hidden_at — модерация, прячет
// альбом везде), поэтому список ведётся здесь. Добавить — вписать id альбома
// (из адреса album.html?id=…) с комментарием, чей и какой.
const FEED_HIDE = new Set([
  '0bc7d74c-cc94-4409-acf4-5b0c1bbf6631', // «Chole Bhature» — Mohd Kaif (@kaifkhanlte)
  '1ff670a7-bb3b-44dd-90c7-fc8a8ec01b28', // «Cat» — Mohd Kaif (@kaifkhanlte)
]);
// Берём с запасом на размер списка, чтобы после фильтра страница была полной.
const LIMIT = PAGE + FEED_HIDE.size;

// Сид живёт ровно одну загрузку страницы: внутри неё hash(id||seed) стабилен,
// поэтому пагинация не дублирует альбомы, — а каждый новый заход перемешивает
// ленту заново. Раньше сид лежал в sessionStorage, вкладка держала его между
// перезагрузками, и порядок казался приколоченным навсегда.
const seed = Math.random().toString(36).slice(2, 10);

let category = null, offset = 0, loading = false, done = false, grid = null;

// Режим ленты: for-you (персональная), trending (в тренде), fresh (как было — всё подряд).
let mode = localStorage.getItem('feedMode') || 'for-you';
let trendPeriod = 'week';

(async function main() {
  await mountShell('home');
  const q = new URLSearchParams(location.search).get('q');

  // Карточка QR-альбома событий лежит в index.html настоящим HTML — её видят
  // краулеры, которые скрипты не исполняют. Здесь она переезжает в ленту:
  // гостю — большой врезкой на месте featured, вошедшему — первой обычной
  // плиткой сетки. Главная у всех одна и та же: шапка, вкладки, чипы, сетка.
  // Цены на главной нет намеренно — она живёт на /events/ и /pricing.
  const ev = document.getElementById('home-event');
  if (ev) {
    ev.remove();
    ev.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
    eventSign = ev.querySelector('.hi-sign');
    eventCouple = ev.querySelector('.ev-couple');
    if (!q) eventCard = ev;
  }

  if (q) return renderSearch(q);
  renderFeed();
})();

// Узлы карточки события из index.html (см. main).
let eventCard = null, eventSign = null, eventCouple = null;

/** Врезка для гостя: занимает большое место featured. */
function eventFeatured() {
  if (!eventCard) return null;
  eventCard.hidden = false;
  return eventCard;
}

/** Плитка для вошедшего: того же размера и устройства, что albumCard. */
function eventTile() {
  if (!eventSign) return null;
  const href = '/events/';
  return el('div', { class: 'ev-tile' },
    el('a', { class: 'card-cover', href, 'aria-label': t('home_ev_more') },
      ...(eventCouple ? [eventCouple.cloneNode(true)] : []),
      eventSign.cloneNode(true),
      el('div', { class: 'badge' }, t('qr_album_full'))),
    el('div', { class: 'card-meta' },
      el('a', { class: 'ev-tile-ico', href, 'aria-hidden': 'true', tabindex: '-1' }, icon('qr', 22, { sw: 2, stroke: '#fff' })),
      el('div', { style: 'min-width:0' },
        el('a', { class: 'card-title', href, text: t('home_ev_tile_title') }),
        el('div', { class: 'card-sub', text: t('home_ev_tile_sub') }),
        el('a', { class: 'card-stat ev-tile-more', href, text: t('home_ev_more') + ' →' }))));
}

/* ---------------- лента ---------------- */

// Пустое состояние внутри сетки — на всю её ширину, а не в одну ячейку.
const wide = (n) => { n.style.gridColumn = '1 / -1'; return n; };

function renderFeed() {
  const guest = !currentProfile();
  const tabs = el('div', { class: 'view-toggle', style: 'margin:8px 0 20px' });
  const chips = el('div', { class: 'chips' });
  const featuredHost = el('div', {});
  grid = el('div', { class: 'grid' });
  const sentinel = el('div', { style: 'height:1px' });

  const drawTabs = () => {
    clear(tabs);
    [['for-you', t('feed_for_you')], ['trending', t('feed_trending')], ['fresh', t('feed_fresh')]]
      .forEach(([m, label]) => tabs.appendChild(el('button', {
        class: mode === m ? 'on' : '', 'data-mode': m,
        onclick: () => { if (mode !== m) { mode = m; localStorage.setItem('feedMode', m); reset(); } },
      }, label)));
  };

  const drawChips = () => {
    clear(chips);
    // в трендах — переключатель периода; в «свежем» — категории;
    // в «для вас» чипов нет: категории учитываются рекомендациями сами
    if (mode === 'trending') {
      [['week', t('period_week')], ['month', t('period_month')]].forEach(([p, label]) =>
        chips.appendChild(el('button', {
          class: 'chip' + (trendPeriod === p ? ' on' : ''),
          onclick: () => { trendPeriod = p; reset(); },
        }, label)));
      return;
    }
    if (mode !== 'fresh') return;
    [null, ...CATEGORIES].forEach(c => {
      chips.appendChild(el('button', {
        class: 'chip' + (category === c ? ' on' : ''),
        onclick: () => { category = c; reset(); },
      }, catLabel(c)));
    });
  };
  drawTabs();
  drawChips();

  clear(app);
  app.append(tabs, chips, featuredHost, grid, sentinel);
  app.appendChild(skeletonGrid(6));

  // Гость видит карточку события сразу, ещё до ответа ленты — и при ошибке
  // или пустой ленте она остаётся на месте.
  const drawFeatured = (a, b, urls, pro) => {
    clear(featuredHost);
    if (guest && eventCard) {
      const wrap = el('div', { class: 'featured featured-event' }, eventFeatured());
      if (a) {
        const side = el('div', { class: 'featured-side' });
        side.append(...albumCard(a, urls, { pro }).childNodes);
        wrap.appendChild(side);
      }
      featuredHost.appendChild(wrap);
    } else if (a) {
      featuredHost.appendChild(featured(a, b, urls, pro));
    }
  };
  drawFeatured();

  function reset() {
    offset = 0; done = false;
    clear(grid);
    drawFeatured();
    drawTabs(); drawChips();
    load();
  }

  async function load() {
    if (loading || done) return;
    loading = true;
    let data, error;
    if (mode === 'trending') {
      // тренды не бесконечны — грузим один раз
      if (offset > 0) { loading = false; done = true; return; }
      ({ data, error } = await sb.rpc('trending_albums', { p_period: trendPeriod, p_limit: 48 + FEED_HIDE.size }));
      done = true;
    } else if (mode === 'for-you') {
      ({ data, error } = await sb.rpc('feed_recommended', { p_seed: seed, p_limit: LIMIT, p_offset: offset }));
    } else {
      ({ data, error } = await sb.rpc('feed_albums', {
        p_seed: seed, p_category: category, p_limit: LIMIT, p_offset: offset,
      }));
    }
    app.querySelectorAll('.skel').forEach(n => n.closest('.grid')?.remove());
    loading = false;

    if (error) {
      if (!offset) { clear(grid); grid.appendChild(wide(emptyState(t('feed_error'), error.message || ''))); }
      return;
    }
    // offset и признак конца считаются по сырому ответу, фильтр — после
    const raw = data || [];
    if (raw.length < LIMIT) done = true;
    const rows = raw.filter(a => !FEED_HIDE.has(a.id));
    if (!rows.length && !done) { offset += raw.length; return load(); }
    if (!rows.length && !offset) {
      clear(grid);
      if (!guest && eventTile()) grid.appendChild(eventTile());
      grid.appendChild(wide(emptyState(
        t('feed_empty_title'),
        t('feed_empty_text'),
        el('a', { class: 'btn btn-primary', href: 'editor.html' }, t('create_first_album')))));
      return;
    }

    const paths = [];
    rows.forEach(a => paths.push(a.cover_path, a.thumb1_path, a.thumb2_path));
    const urls = await signUrls(paths);

    const pro = await proSet(rows.map(a => a.author_username));
    let rest = rows;
    if (offset === 0 && rows.length >= 1) {
      // Во врезку уходят первый и (если есть) второй альбом — в сетке их быть
      // не должно. У гостя большое место занято карточкой события, поэтому
      // альбом во врезке один — справа от неё.
      const take = guest && eventCard ? 1 : (rows.length >= 2 ? 2 : 1);
      rest = rows.slice(take);
      drawFeatured(rows[0], take === 2 ? rows[1] : null, urls, pro);
      // Вошедшему событие — первая обычная плитка сетки.
      if (!guest) { const tile = eventTile(); if (tile) grid.appendChild(tile); }
    }
    rest.forEach(a => grid.appendChild(albumCard(a, urls, { pro })));
    offset += raw.length;
    observeImpressions(app);   // учёт показов карточек
  }

  // IntersectionObserver + scroll-фолбэк (в throttled-окружениях IO не срабатывает).
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) load(); }, { rootMargin: '600px' });
  io.observe(sentinel);
  addEventListener('scroll', () => {
    if (innerHeight + scrollY > document.body.offsetHeight - 900) load();
  }, { passive: true });

  load();
}

function featured(a, b, urls, pro) {
  const wrap = el('div', { class: 'featured' });
  const cover = urls[a.cover_path] || urls[a.thumb1_path];
  const main = el('a', { class: 'featured-main', href: `album.html?id=${a.id}` });
  if (cover) main.appendChild(el('img', { src: cover, alt: a.title }));
  main.appendChild(el('div', { class: 'hero-card' },
    el('div', { class: 'hero-inner' },
      el('div', { class: 'hero-title', text: a.title }),
      el('div', { class: 'hero-sub', text: a.author_name || a.author_username }),
      el('div', { class: 'pill', text: composition(a) }),
      el('div', { style: 'font-size:18px;font-weight:700;margin-top:15px', text: t('watch') }))));
  wrap.appendChild(main);

  if (b) {
    const side = el('div', { class: 'featured-side' });
    const card = albumCard(b, urls, { pro });
    side.append(...card.childNodes);
    wrap.appendChild(side);
  }
  return wrap;
}

/* ---------------- поиск ---------------- */
async function renderSearch(q) {
  clear(app).append(
    el('h1', { style: 'font-size:30px;font-weight:800;letter-spacing:-.02em;margin:8px 0 24px', text: t('search_title', { q }) }),
    skeletonGrid(4));

  const { data, error } = await sb.rpc('search_all', { p_q: q });
  if (error) { clear(app).appendChild(emptyState(t('search_failed'), error.message || '')); return; }

  const albums = data?.albums || [], people = data?.people || [];
  clear(app).appendChild(el('h1', {
    style: 'font-size:30px;font-weight:800;letter-spacing:-.02em;margin:8px 0 24px', text: t('search_title', { q }),
  }));

  if (people.length) {
    const pro = await proSet(people.map(p => p.username));
    app.appendChild(el('div', { class: 'section-head' }, el('h2', { text: t('search_people') })));
    const row = el('div', { class: 'grid' });
    people.forEach(p => row.appendChild(el('a', {
      class: 'side-card', href: `profile.html?u=${encodeURIComponent(p.username)}`,
      style: 'display:flex;gap:14px;align-items:center',
    },
      avatarImg(p.avatar, p.name, 52, pro.has(p.username)),
      el('div', { style: 'min-width:0' },
        el('div', { style: 'font-size:17px;font-weight:700', text: p.name || p.username }),
        el('div', { class: 'card-sub', text: '@' + p.username })))));
    app.appendChild(row);
  }

  app.appendChild(el('div', { class: 'section-head' }, el('h2', { text: t('search_albums') })));
  if (!albums.length) {
    app.appendChild(emptyState(t('search_no_albums'), t('search_try_other')));
    return;
  }
  const paths = [];
  albums.forEach(a => paths.push(a.cover_path, a.thumb1, a.thumb2));
  const urls = await signUrls(paths);
  const proA = await proSet(albums.map(a => a.author_username));
  const g = el('div', { class: 'grid' });
  albums.forEach(a => g.appendChild(albumCard({
    ...a, cover_path: a.cover_path, thumb1_path: a.thumb1, thumb2_path: a.thumb2,
    published_at: a.published_at,
  }, urls, { pro: proA })));
  app.appendChild(g);
}
