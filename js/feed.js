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

  // Статическая витрина из index.html: краулерам и гостям — остаётся (гостю
  // её переводим на его язык), залогиненным и в режиме поиска — лишняя.
  const intro = document.getElementById('home-intro');
  const landingOnly = !!intro && !q && !currentProfile();
  if (intro) {
    if (!landingOnly) intro.remove();
    else intro.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
  }

  // Лендинг — торговая страница QR-альбомов, и ленты на ней нет: чужие альбомы
  // под ценой и FAQ уводят внимание с покупки. Лента остаётся главной для
  // вошедших и включается в режиме поиска.
  if (landingOnly) return;

  if (q) return renderSearch(q);
  renderFeed();
})();

/* ---------------- лента ---------------- */

// Гостю над лентой показываем, что это за сервис: описание + вход + цены.
function renderFeed() {
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

  function reset() {
    offset = 0; done = false;
    clear(featuredHost); clear(grid);
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
      ({ data, error } = await sb.rpc('trending_albums', { p_period: trendPeriod, p_limit: 48 }));
      done = true;
    } else if (mode === 'for-you') {
      ({ data, error } = await sb.rpc('feed_recommended', { p_seed: seed, p_limit: PAGE, p_offset: offset }));
    } else {
      ({ data, error } = await sb.rpc('feed_albums', {
        p_seed: seed, p_category: category, p_limit: PAGE, p_offset: offset,
      }));
    }
    app.querySelectorAll('.skel').forEach(n => n.closest('.grid')?.remove());
    loading = false;

    if (error) {
      if (!offset) clear(app).appendChild(emptyState(t('feed_error'), error.message || ''));
      return;
    }
    const rows = data || [];
    if (rows.length < PAGE) done = true;
    if (!rows.length && !offset) {
      clear(featuredHost);
      grid.replaceWith(emptyState(
        t('feed_empty_title'),
        t('feed_empty_text'),
        el('a', { class: 'btn btn-primary', href: 'editor.html' }, t('create_first_album'))));
      return;
    }

    const paths = [];
    rows.forEach(a => paths.push(a.cover_path, a.thumb1_path, a.thumb2_path));
    const urls = await signUrls(paths);

    const pro = await proSet(rows.map(a => a.author_username));
    let rest = rows;
    if (offset === 0 && rows.length >= 1) {
      // во врезку уходят первый и (если есть) второй альбом — в сетке их быть не должно
      rest = rows.slice(rows.length >= 2 ? 2 : 1);
      featuredHost.appendChild(featured(rows[0], rows[1], urls, pro));
    }
    rest.forEach(a => grid.appendChild(albumCard(a, urls, { pro })));
    offset += rows.length;
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
