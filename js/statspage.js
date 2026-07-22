// Личный кабинет статистики автора: показы, посещения, удержание, аудитория.
// Все числа приходят одной агрегатной функцией stats_summary — сырые события
// клиенту не видны вообще.
import { sb, isAuthed, currentProfile } from './sb.js';
import { el, $, clear, mountShell, emptyState, showLogin, fmtCount, t, icon } from './ui.js';

const app = $('#app');
let days = 30;
let albumId = null;
let data = null;

(async function main() {
  await mountShell('stats');
  if (!isAuthed()) {
    app.appendChild(emptyState(t('st_title'), t('st_need_auth'),
      el('button', { class: 'btn btn-primary', onclick: () => showLogin(t('st_need_auth')) }, t('sign_in'))));
    return;
  }
  render();
  await load();
})();

async function load() {
  const { data: d, error } = await sb.rpc('stats_summary', { p_album: albumId, p_days: days });
  if (error) { clear($('#st-body')).appendChild(emptyState(t('st_title'), error.message)); return; }
  data = d;
  draw();
}

/* ---------------- каркас ---------------- */

function render() {
  clear(app);
  app.appendChild(el('h1', { style: 'font-size:30px;font-weight:800;margin:8px 0 4px', text: t('st_title') }));
  app.appendChild(el('p', { class: 'muted', style: 'margin:0 0 22px', text: t('st_sub') }));

  const bar = el('div', { class: 'rowx', style: 'margin-bottom:22px' });
  [[7, t('st_d7')], [30, t('st_d30')], [90, t('st_d90')]].forEach(([n, label]) => {
    bar.appendChild(el('button', {
      class: 'chip' + (days === n ? ' on' : ''),
      onclick: async (e) => {
        days = n;
        bar.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
        e.currentTarget.classList.add('on');
        await load();
      },
    }, label));
  });

  const sel = el('select', { class: 'select', style: 'width:auto;min-width:220px;padding:10px 14px;height:40px' },
    el('option', { value: '', text: t('st_all_albums') }));
  sel.onchange = async () => { albumId = sel.value || null; await load(); };
  bar.appendChild(sel);
  app.append(bar, el('div', { id: 'st-body' }));

  const body = $('#st-body');
  body.appendChild(el('div', { class: 'skel', style: 'height:220px;border-radius:18px' }));
}

function draw() {
  const body = clear($('#st-body'));
  const T = data.totals || {};
  const pro = data.plan === 'pro';

  // список альбомов в переключателе — только при первой отрисовке
  const sel = app.querySelector('select.select');
  if (sel && sel.options.length === 1) {
    (data.albums || []).forEach(a => sel.appendChild(el('option', { value: a.id, text: a.title })));
  }

  body.appendChild(tiles([
    [t('st_impressions'), fmtCount(T.impressions || 0), t('st_impressions_hint')],
    [t('st_views'), fmtCount(T.views || 0), t('st_views_hint')],
    [t('st_ctr'), pct(T.views, T.impressions), t('st_ctr_hint')],
    [t('st_dwell'), secs(T.avg_dwell_ms), t('st_dwell_hint')],
    [t('st_viewers'), fmtCount(T.viewers || 0), t('st_viewers_hint')],
    [t('st_reactions'), fmtCount((T.likes || 0) + (T.comments || 0)), t('st_reactions_hint')],
  ]));

  body.appendChild(card(t('st_by_day'), dayChart(data.by_day || [])));

  const cols = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;margin-top:20px' });
  cols.append(
    card(t('st_geo'), bars((data.geo || []).map(g => [countryName(g.code), g.n]))),
    card(t('st_age'), bars((data.age || []).map(g => [ageLabel(g.bucket), g.n]))),
    card(t('st_gender'), bars((data.gender || []).map(g => [genderLabel(g.bucket), g.n]))),
    card(t('st_sources'), bars((data.sources || []).map(g => [sourceLabel(g.source), g.n]))),
    card(t('st_retention'), bars((data.dwell || []).map(g => [g.bucket, g.n])), t('st_retention_hint')),
  );
  body.appendChild(cols);

  if (!albumId) body.appendChild(card(t('st_by_album'), albumTable(data.albums || [])));
  body.appendChild(buttonsBlock(pro, data.buttons || []));
}

/* ---------------- блоки ---------------- */

function tiles(items) {
  const wrap = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:20px',
  });
  items.forEach(([label, value, hint]) => {
    wrap.appendChild(el('div', { class: 'side-card', style: 'padding:18px' },
      el('div', { class: 'muted', style: 'font-size:13.5px', text: label }),
      el('div', { style: 'font-size:28px;font-weight:800;margin-top:4px', text: value }),
      hint ? el('div', { class: 'muted', style: 'font-size:12.5px;margin-top:2px', text: hint }) : null));
  });
  return wrap;
}

function card(title, node, hint) {
  return el('div', { class: 'side-card', style: 'margin-top:20px' },
    el('div', { style: 'font-size:17px;font-weight:700;margin-bottom:4px', text: title }),
    hint ? el('div', { class: 'muted', style: 'font-size:13px;margin-bottom:10px', text: hint }) : null,
    node);
}

/** Столбики по дням: посещения поверх показов. Рисуем инлайновым SVG, без библиотек. */
function dayChart(rows) {
  if (!rows.length) return el('div', { class: 'muted', text: t('st_no_data') });
  const W = 720, H = 160, pad = 4;
  const max = Math.max(1, ...rows.map(r => Math.max(r.impressions || 0, r.views || 0)));
  const bw = W / rows.length;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 22}`);
  svg.setAttribute('style', 'width:100%;height:auto;display:block');

  rows.forEach((r, i) => {
    const add = (v, color, w, off) => {
      const h = Math.round((v / max) * H);
      if (h <= 0) return;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(i * bw + off));
      rect.setAttribute('y', String(H - h));
      rect.setAttribute('width', String(Math.max(1, w)));
      rect.setAttribute('height', String(h));
      rect.setAttribute('rx', '2');
      rect.setAttribute('fill', color);
      const ttl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      ttl.textContent = `${r.day}: ${v}`;
      rect.appendChild(ttl);
      svg.appendChild(rect);
    };
    add(r.impressions || 0, '#E2DED6', bw - pad, pad / 2);
    add(r.views || 0, '#E8552B', (bw - pad) * 0.55, pad / 2 + (bw - pad) * 0.225);
  });

  const label = (i, txt) => {
    const tx = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    tx.setAttribute('x', String(i * bw + bw / 2));
    tx.setAttribute('y', String(H + 16));
    tx.setAttribute('text-anchor', 'middle');
    tx.setAttribute('font-size', '11');
    tx.setAttribute('fill', '#8F8B84');
    tx.textContent = txt;
    svg.appendChild(tx);
  };
  const short = (d) => String(d).slice(5).replace('-', '.');
  label(0, short(rows[0].day));
  if (rows.length > 2) label(rows.length - 1, short(rows[rows.length - 1].day));

  return el('div', {},
    el('div', { class: 'rowx', style: 'gap:16px;margin-bottom:8px;font-size:13px' },
      legend('#E8552B', t('st_views')), legend('#E2DED6', t('st_impressions'))),
    svg);
}

function legend(color, text) {
  return el('span', { class: 'rowx', style: 'gap:6px' },
    el('i', { style: `width:10px;height:10px;border-radius:3px;background:${color};display:inline-block` }),
    el('span', { class: 'muted', text }));
}

/** Горизонтальные полосы: подпись, полоса, число. */
function bars(rows) {
  const clean = rows.filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!clean.length) return el('div', { class: 'muted', text: t('st_no_data') });
  const max = Math.max(...clean.map(r => r[1]));
  const total = clean.reduce((s, r) => s + r[1], 0);
  const box = el('div', { class: 'stack', style: 'gap:10px;margin-top:10px' });
  clean.forEach(([label, n]) => {
    box.appendChild(el('div', {},
      el('div', { style: 'display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px' },
        el('span', { text: label }),
        el('span', { class: 'muted', text: `${fmtCount(n)} · ${Math.round((n / total) * 100)}%` })),
      el('div', { style: 'height:8px;border-radius:99px;background:#EFEDE8;overflow:hidden' },
        el('i', { style: `display:block;height:100%;border-radius:99px;background:#E8552B;width:${Math.max(3, (n / max) * 100)}%` }))));
  });
  return box;
}

function albumTable(rows) {
  if (!rows.length) return el('div', { class: 'muted', text: t('st_no_albums') });
  const head = el('div', {
    class: 'muted',
    style: 'display:grid;grid-template-columns:2fr repeat(4,minmax(64px,.7fr));gap:8px;font-size:12.5px;padding:6px 0;border-bottom:1px solid #EFEDE8',
  },
    el('span', { text: t('st_album') }), el('span', { text: t('st_impressions') }),
    el('span', { text: t('st_views') }), el('span', { text: t('st_dwell') }),
    el('span', { text: t('st_reactions') }));
  const box = el('div', { style: 'margin-top:8px' }, head);
  rows.forEach(a => {
    box.appendChild(el('div', {
      style: 'display:grid;grid-template-columns:2fr repeat(4,minmax(64px,.7fr));gap:8px;font-size:14.5px;padding:10px 0;border-bottom:1px solid #F5F3EF;align-items:center',
    },
      el('a', { href: `album.html?id=${a.id}`, style: 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: a.title || '—' }),
      el('span', { text: fmtCount(a.impressions || 0) }),
      el('span', { text: fmtCount(a.views || 0) }),
      el('span', { text: secs(a.avg_dwell_ms) }),
      el('span', { text: fmtCount((a.likes || 0) + (a.comments || 0)) })));
  });
  return box;
}

/** Переходы по кнопкам — только на Pro. Для остальных заглушка со ссылкой на тариф. */
function buttonsBlock(pro, rows) {
  if (!pro) {
    return card(t('st_buttons'), el('div', {},
      el('div', { class: 'muted', style: 'font-size:14.5px', text: t('st_buttons_pro') }),
      el('a', { class: 'btn btn-primary', style: 'margin-top:12px;display:inline-flex', href: 'pricing.html' }, t('st_see_pro'))));
  }
  if (!rows.length) {
    return card(t('st_buttons'), el('div', {},
      el('div', { class: 'muted', style: 'font-size:14.5px', text: t('st_buttons_empty') }),
      el('a', {
        class: 'btn btn-ghost', style: 'margin-top:12px;display:inline-flex',
        href: `profile.html?u=${encodeURIComponent(currentProfile()?.username || '')}`,
      }, t('st_add_buttons'))));
  }
  return card(t('st_buttons'), bars(rows.map(b => [b.label, b.clicks])), t('st_buttons_hint'));
}

/* ---------------- форматирование ---------------- */

function pct(a, b) { return b ? `${Math.round((a / b) * 100)}%` : '—'; }

function secs(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (!s) return '—';
  if (s < 60) return `${s} ${t('st_sec')}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let dn = null;
function countryName(code) {
  if (!code || code === '??') return t('st_unknown');
  try {
    if (!dn) dn = new Intl.DisplayNames([document.documentElement.lang || 'en'], { type: 'region' });
    return dn.of(code) || code;
  } catch (_) { return code; }
}

function ageLabel(b) { return b === 'unknown' ? t('st_unknown') : b; }
function genderLabel(b) {
  return b === 'female' ? t('st_female') : b === 'male' ? t('st_male')
    : b === 'other' ? t('st_other') : t('st_unknown');
}
function sourceLabel(s) {
  const key = {
    feed: 'st_src_feed', search: 'st_src_search', profile: 'st_src_profile',
    calendar: 'st_src_calendar', invite: 'st_src_invite', posts: 'st_src_posts',
    album: 'st_src_album', external: 'st_src_external', direct: 'st_src_direct',
  }[s];
  return key ? t(key) : (s || t('st_src_direct'));
}
