// Календарь: альбомы, разложенные по времени. Группируем по году и месяцу.
//
// Дата берётся из date_from альбома (если владелец её задал), иначе из даты
// публикации. calendar_albums отдаёт только видимые зрителю.
import { sb } from './sb.js';
import {
  el, $, clear, mountShell, signUrls, albumCard, emptyState, icon, t, currentLang,
} from './ui.js';

const app = $('#app');
let year = null;   // null = все годы

(async function main() {
  await mountShell('home');
  document.title = t('calendar_title') + ' — Albums';
  render();
})();

async function render() {
  clear(app);
  app.appendChild(el('h1', {
    style: 'font-size:34px;font-weight:800;letter-spacing:-.03em;margin:6px 0 8px',
    text: t('calendar_title'),
  }));

  const yearBar = el('div', { class: 'chips', style: 'margin-bottom:20px' });
  const body = el('div', {});
  app.append(yearBar, body);
  body.appendChild(el('div', { class: 'muted', text: t('loading') }));

  const { data, error } = await sb.rpc('calendar_albums', { p_year: year });
  if (error) { clear(body).appendChild(emptyState(t('feed_error'), error.message)); return; }
  const list = data || [];

  // годы для переключателя — из всех альбомов (первый запрос без фильтра),
  // но чтобы не делать второй вызов, собираем годы из текущей выдачи при p_year=null
  const years = [...new Set(list.map(a => yearOf(a)).filter(Boolean))].sort((x, y) => y - x);
  drawYears(years);

  clear(body);
  if (!list.length) {
    body.appendChild(emptyState(t('calendar_empty_title'), t('calendar_empty_text'),
      el('a', { class: 'btn btn-primary', href: 'editor.html' }, t('create_first_album'))));
    return;
  }

  // группировка по «год · месяц»
  const groups = new Map();
  for (const a of list) {
    const d = dateOf(a);
    if (!d) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, { d, items: [] });
    groups.get(key).items.push(a);
  }
  const keys = [...groups.keys()].sort().reverse();

  const paths = list.flatMap(a => [a.cover_path]);
  const urls = await signUrls(paths);

  for (const key of keys) {
    const g = groups.get(key);
    body.appendChild(el('div', { class: 'cal-group' },
      el('div', { class: 'cal-heading' },
        icon('calendar', 18, { sw: 2, stroke: '#9B978F' }),
        el('span', { text: monthLabel(g.d) })),
      grid(g.items, urls)));
  }

  function drawYears(ys) {
    clear(yearBar);
    yearBar.appendChild(chip(null, t('all')));
    ys.forEach(y => yearBar.appendChild(chip(y, String(y))));
  }
  function chip(val, label) {
    return el('button', {
      class: 'chip' + (year === val ? ' on' : ''),
      onclick: () => { if (year !== val) { year = val; render(); } },
    }, label);
  }
}

function grid(items, urls) {
  const g = el('div', { class: 'grid' });
  items.forEach(a => {
    const card = albumCard({
      ...a, cover_path: a.cover_path, thumb1_path: a.cover_path,
    }, urls, { hideAuthor: false });
    // подпись даты альбома, если задана
    const label = albumDateLabel(a);
    if (label) card.querySelector('.card-stat')?.before(
      el('div', { class: 'card-stat', style: 'color:var(--accent-ink);font-weight:600', text: label }));
    g.appendChild(card);
  });
  return g;
}

/* ---- даты ---- */
function yearOf(a) {
  const d = dateOf(a);
  return d ? d.getFullYear() : null;
}
function dateOf(a) {
  const raw = a.date_from || a.published_at;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}
function monthLabel(d) {
  try { return d.toLocaleDateString(currentLang(), { month: 'long', year: 'numeric' }); }
  catch (_) { return `${d.getFullYear()}`; }
}
function albumDateLabel(a) {
  if (!a.date_from) return null;
  const from = new Date(a.date_from);
  const loc = currentLang();
  const fmt = (d, o) => { try { return d.toLocaleDateString(loc, o); } catch (_) { return ''; } };
  if (a.precision === 'year') return String(from.getFullYear());
  if (a.precision === 'month') return fmt(from, { month: 'long', year: 'numeric' });
  if (a.precision === 'range' && a.date_to) {
    const to = new Date(a.date_to);
    return `${fmt(from, { day: 'numeric', month: 'short' })} – ${fmt(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  return fmt(from, { day: 'numeric', month: 'long', year: 'numeric' });
}
