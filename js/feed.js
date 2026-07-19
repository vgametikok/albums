// Главная: лента рекомендаций альбомов + режим поиска (?q=).
import { sb } from './sb.js';
import { CATEGORIES } from './config.js';
import {
  el, $, clear, mountShell, albumCard, skeletonGrid, signUrls, emptyState,
  composition, fmtCount, timeAgo, avatarImg, icon, playTriangle,
} from './ui.js';

const app = $('#app');
const PAGE = 24;

// Сид держим на сессию — так пагинация не дублирует альбомы между страницами.
let seed = sessionStorage.getItem('feedSeed');
if (!seed) { seed = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('feedSeed', seed); }

let category = null, offset = 0, loading = false, done = false, grid = null;

(async function main() {
  await mountShell('home');
  const q = new URLSearchParams(location.search).get('q');
  if (q) return renderSearch(q);
  renderFeed();
})();

/* ---------------- лента ---------------- */
function renderFeed() {
  const chips = el('div', { class: 'chips' });
  const featuredHost = el('div', {});
  grid = el('div', { class: 'grid' });
  const sentinel = el('div', { style: 'height:1px' });

  const drawChips = () => {
    clear(chips);
    [null, ...CATEGORIES].forEach(c => {
      chips.appendChild(el('button', {
        class: 'chip' + (category === c ? ' on' : ''),
        onclick: () => { category = c; reset(); },
      }, c || 'All'));
    });
  };
  drawChips();

  clear(app).append(chips, featuredHost, grid, sentinel);
  app.appendChild(skeletonGrid(6));

  function reset() {
    offset = 0; done = false;
    clear(featuredHost); clear(grid);
    drawChips();
    load();
  }

  async function load() {
    if (loading || done) return;
    loading = true;
    const { data, error } = await sb.rpc('feed_albums', {
      p_seed: seed, p_category: category, p_limit: PAGE, p_offset: offset,
    });
    app.querySelectorAll('.skel').forEach(n => n.closest('.grid')?.remove());
    loading = false;

    if (error) {
      if (!offset) clear(app).appendChild(emptyState('Could not load the feed', error.message || ''));
      return;
    }
    const rows = data || [];
    if (rows.length < PAGE) done = true;
    if (!rows.length && !offset) {
      clear(featuredHost);
      grid.replaceWith(emptyState(
        'Nothing here yet',
        'Albums that are public — or shared with you — will show up in this feed.',
        el('a', { class: 'btn btn-primary', href: 'editor.html' }, 'Create the first album')));
      return;
    }

    const paths = [];
    rows.forEach(a => paths.push(a.cover_path, a.thumb1_path, a.thumb2_path));
    const urls = await signUrls(paths);

    let rest = rows;
    if (offset === 0 && rows.length >= 1) {
      rest = rows.slice(rows.length >= 3 ? 2 : 1);
      featuredHost.appendChild(featured(rows[0], rows[1], urls));
    }
    rest.forEach(a => grid.appendChild(albumCard(a, urls)));
    offset += rows.length;
  }

  // IntersectionObserver + scroll-фолбэк (в throttled-окружениях IO не срабатывает).
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) load(); }, { rootMargin: '600px' });
  io.observe(sentinel);
  addEventListener('scroll', () => {
    if (innerHeight + scrollY > document.body.offsetHeight - 900) load();
  }, { passive: true });

  load();
}

function featured(a, b, urls) {
  const wrap = el('div', { class: 'featured' });
  const cover = urls[a.cover_path] || urls[a.thumb1_path];
  const main = el('a', { class: 'featured-main', href: `album.html?id=${a.id}` });
  if (cover) main.appendChild(el('img', { src: cover, alt: a.title }));
  main.appendChild(el('div', { class: 'hero-card' },
    el('div', { class: 'hero-inner' },
      el('div', { class: 'hero-title', text: a.title }),
      el('div', { class: 'hero-sub', text: a.author_name || a.author_username }),
      el('div', { class: 'pill', text: composition(a) }),
      el('div', { style: 'font-size:18px;font-weight:700;margin-top:15px', text: 'Watch' }))));
  wrap.appendChild(main);

  if (b) {
    const side = el('div', { class: 'featured-side' });
    const card = albumCard(b, urls);
    side.append(...card.childNodes);
    wrap.appendChild(side);
  }
  return wrap;
}

/* ---------------- поиск ---------------- */
async function renderSearch(q) {
  clear(app).append(
    el('h1', { style: 'font-size:30px;font-weight:800;letter-spacing:-.02em;margin:8px 0 24px', text: `Search: ${q}` }),
    skeletonGrid(4));

  const { data, error } = await sb.rpc('search_all', { p_q: q });
  if (error) { clear(app).appendChild(emptyState('Search failed', error.message || '')); return; }

  const albums = data?.albums || [], people = data?.people || [];
  clear(app).appendChild(el('h1', {
    style: 'font-size:30px;font-weight:800;letter-spacing:-.02em;margin:8px 0 24px', text: `Search: ${q}`,
  }));

  if (people.length) {
    app.appendChild(el('div', { class: 'section-head' }, el('h2', { text: 'People' })));
    const row = el('div', { class: 'grid' });
    people.forEach(p => row.appendChild(el('a', {
      class: 'side-card', href: `profile.html?u=${encodeURIComponent(p.username)}`,
      style: 'display:flex;gap:14px;align-items:center',
    },
      avatarImg(p.avatar, p.name, 52),
      el('div', { style: 'min-width:0' },
        el('div', { style: 'font-size:17px;font-weight:700', text: p.name || p.username }),
        el('div', { class: 'card-sub', text: '@' + p.username })))));
    app.appendChild(row);
  }

  app.appendChild(el('div', { class: 'section-head' }, el('h2', { text: 'Albums' })));
  if (!albums.length) {
    app.appendChild(emptyState('No albums found', 'Try a different title or creator.'));
    return;
  }
  const paths = [];
  albums.forEach(a => paths.push(a.cover_path, a.thumb1, a.thumb2));
  const urls = await signUrls(paths);
  const g = el('div', { class: 'grid' });
  albums.forEach(a => g.appendChild(albumCard({
    ...a, cover_path: a.cover_path, thumb1_path: a.thumb1, thumb2_path: a.thumb2,
    published_at: a.published_at,
  }, urls)));
  app.appendChild(g);
}
