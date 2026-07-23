// Общий альбом события: постоянный QR для гостей + разбор того, что они залили.
//
// Две страницы в одном файле:
//   event.html          — список моих событий и создание нового (тратит квоту);
//   event.html?id=<uuid> — управление одним событием: QR, настройки, гости,
//                          разбор фотографий по видимости.
//
// Право на событие даёт квота event_quota.credits (её выдаёт админ после
// оплаты). Без квоты страница объясняет, что это, и ведёт на тариф.
import { sb, isAuthed } from './sb.js';
import {
  el, $, clear, mountShell, signUrls, toast, showLogin, emptyState, icon, t,
  thumbEl, dur, modal, avatarImg,
} from './ui.js';
import { qrSvg, qrDownload } from './qr.js';

const app = $('#app');
const albumId = new URLSearchParams(location.search).get('id');

let credits = 0;

(async function main() {
  await mountShell('profile');
  document.title = `${t('ev_title')} — Albums`;

  if (!isAuthed()) {
    app.appendChild(emptyState(t('ev_title'), t('ev_signin_text'),
      el('button', { class: 'btn btn-primary', onclick: () => showLogin(t('ev_signin_text')) }, t('sign_in'))));
    return;
  }
  if (albumId) await renderOne();
  else await renderList();
})();

/* ================================================================ список */

async function renderList() {
  clear(app);
  const [{ data: cr }, { data: list }] = await Promise.all([
    sb.rpc('my_event_credits'),
    sb.rpc('my_event_albums'),
  ]);
  credits = Number(cr) || 0;
  const albums = list || [];

  app.appendChild(el('div', { class: 'section-head', style: 'margin:0 0 6px' },
    el('h1', { style: 'font-size:30px;letter-spacing:-.02em', text: t('ev_title') })));
  app.appendChild(el('p', { class: 'lede', style: 'margin:0 0 24px;max-width:720px', text: t('ev_lede') }));

  /* квота и создание */
  const quota = el('div', { class: 'side-card', style: 'max-width:720px' });
  if (credits > 0) {
    quota.append(
      el('div', { class: 'label', text: t('ev_available') }),
      el('div', { style: 'font-size:32px;font-weight:800;letter-spacing:-.02em;margin-top:4px',
        text: String(credits) }),
      el('div', { class: 'muted', style: 'font-size:14.5px;margin-top:4px', text: t('ev_available_hint') }),
      el('button', { class: 'btn btn-primary', style: 'margin-top:16px', onclick: openCreate },
        icon('plus', 16, { sw: 2.4 }), t('ev_create')));
  } else {
    quota.append(
      el('div', { class: 'label', text: t('ev_none_title') }),
      el('div', { class: 'muted', style: 'font-size:15px;line-height:1.6;margin-top:8px', text: t('ev_none_text') }),
      el('a', { class: 'btn btn-primary', style: 'margin-top:16px', href: 'pricing.html' }, t('ev_see_pricing')));
  }
  app.appendChild(quota);

  /* что это даёт — короткой памяткой, чтобы не гадать до покупки */
  app.appendChild(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin-top:22px;max-width:1080px' },
    featureCard('ev_f1_t', 'ev_f1_d'),
    featureCard('ev_f2_t', 'ev_f2_d'),
    featureCard('ev_f3_t', 'ev_f3_d')));

  if (!albums.length) return;

  app.appendChild(el('div', { class: 'section-head', style: 'margin:40px 0 16px' },
    el('h2', { text: t('ev_my') })));

  const urls = await signUrls(albums.flatMap(a => [a.cover_path, a.thumb1]));
  const grid = el('div', { class: 'grid' });
  albums.forEach(a => {
    const cover = urls[a.cover_path] || urls[a.thumb1];
    const card = el('a', { href: `event.html?id=${a.id}`, style: 'display:block' });
    const box = el('div', { class: 'card-cover' });
    if (cover) box.appendChild(el('img', { src: cover, alt: a.title, style: 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover' }));
    box.appendChild(el('div', { class: 'badge' },
      icon('users', 12, { stroke: '#fff', sw: 2 }), t('ev_guests_n', { count: a.guests || 0 })));
    if (a.items_hidden > 0) {
      box.appendChild(el('div', { class: 'badge badge-lock', style: 'bottom:auto;top:12px;background:rgba(232,85,43,.92)',
        text: t('ev_to_review_n', { count: a.items_hidden }) }));
    }
    card.appendChild(box);
    card.appendChild(el('div', { class: 'card-meta' },
      el('div', { style: 'min-width:0' },
        el('span', { class: 'card-title', text: a.title }),
        el('span', { class: 'card-sub', text: statusText(a) }),
        el('div', { class: 'card-stat', text: t('ev_items_n', { count: a.items_total || 0 }) }))));
    grid.appendChild(card);
  });
  app.appendChild(grid);
}

function featureCard(titleKey, textKey) {
  return el('div', { class: 'side-card', style: 'margin:0' },
    el('div', { style: 'font-size:16px;font-weight:700', text: t(titleKey) }),
    el('div', { class: 'muted', style: 'font-size:14.5px;line-height:1.55;margin-top:6px', text: t(textKey) }));
}

function statusText(a) {
  if (a.visibility === 'private') return t('ev_st_private');
  if (!a.published_at) return t('ev_st_draft');
  if (a.moderation_status === 'pending') return t('ev_st_review');
  if (a.moderation_status === 'rejected') return t('ev_st_rejected');
  return a.visibility === 'friends' ? t('ev_st_friends') : t('ev_st_public');
}

function openCreate() {
  modal((box, close) => {
    box.appendChild(el('h2', { text: t('ev_create') }));
    box.appendChild(el('p', { class: 'muted', style: 'margin:0 0 14px;font-size:14.5px', text: t('ev_create_hint') }));

    const title = el('input', { class: 'input', placeholder: t('ev_f_title'), maxlength: '120' });
    const desc = el('textarea', { class: 'input', rows: '3', style: 'margin-top:10px;height:auto;padding:10px 14px',
      placeholder: t('ev_f_desc'), maxlength: '600' });

    const opts = [
      ['private', t('ev_vis_private'), t('ev_vis_private_d')],
      ['friends', t('ev_vis_friends'), t('ev_vis_friends_d')],
      ['public', t('ev_vis_public'), t('ev_vis_public_d')],
    ];
    const wrap = el('div', { class: 'vis-opts', style: 'margin-top:14px' });
    let vis = 'private';
    opts.forEach(([val, ttl, sub]) => {
      const input = el('input', { type: 'radio', name: 'evvis', value: val, checked: val === vis ? 'checked' : null,
        onchange: () => { vis = val; wrap.querySelectorAll('.vis-opt').forEach(n => n.classList.toggle('on', n.contains(input) && input.checked)); } });
      wrap.appendChild(el('label', { class: 'vis-opt' + (val === vis ? ' on' : '') },
        input, el('div', {}, el('b', { text: ttl }), el('span', { text: sub }))));
    });

    const go = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:18px' }, t('ev_create_go'));
    go.onclick = async () => {
      if (!title.value.trim()) { toast(t('ev_need_title')); return; }
      go.disabled = true;
      const { data, error } = await sb.rpc('event_album_create', {
        p_title: title.value.trim(), p_visibility: vis, p_description: desc.value.trim() || null,
      });
      if (error) { go.disabled = false; toast(error.message); return; }
      close();
      location.href = `event.html?id=${data.album_id}`;
    };

    box.append(title, desc, wrap, go,
      el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, t('cancel')));
  });
}

/* ================================================================ одно событие */

async function renderOne() {
  clear(app);
  const { data, error } = await sb.rpc('get_album', { p_id: albumId });
  if (error || !data) { app.appendChild(emptyState(t('album_not_found'), t('album_not_found_text'))); return; }
  const a = data.album;
  if (!data.is_author) { app.appendChild(emptyState(t('ev_not_yours'), t('ev_not_yours_text'))); return; }
  if (!a.is_event) { location.href = `editor.html?id=${a.id}`; return; }

  document.title = `${a.title} — Albums`;
  app.appendChild(el('a', { class: 'back', href: 'event.html' }, icon('back', 16, { sw: 2 }), t('ev_all')));
  app.appendChild(el('div', { class: 'section-head', style: 'margin:0 0 20px' },
    el('h1', { style: 'font-size:30px;letter-spacing:-.02em', text: a.title }),
    el('div', { class: 'rowx' },
      el('span', { class: 'chip', style: 'pointer-events:none', text: statusText({ ...a, ...data.album }) }),
      el('a', { class: 'btn btn-ghost btn-sm', href: `album.html?id=${a.id}` }, t('ev_open_album')))));

  const cols = el('div', { class: 'album-cols' });
  const left = el('div', { style: 'min-width:0' });
  const right = el('aside', {});
  cols.append(left, right);
  app.appendChild(cols);

  right.append(await linkBox(a), settingsBox(a), await guestsBox(a));
  await mediaBox(left, data);
}

/* ---------------------------------------------------------------- QR и ссылка */

async function linkBox(a) {
  const box = el('div', { class: 'side-card' },
    el('div', { class: 'label', text: t('ev_link_title') }),
    el('div', { class: 'muted', style: 'font-size:14px;line-height:1.5;margin-top:6px', text: t('ev_link_hint') }));
  const body = el('div', { style: 'margin-top:14px' });
  box.appendChild(body);

  const draw = (token) => {
    clear(body);
    const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}join.html?t=${token}`;

    const qrWrap = el('div', { style: 'background:#fff;border-radius:16px;padding:14px;display:flex;justify-content:center' });
    qrWrap.appendChild(qrSvg(url, 220));
    body.appendChild(qrWrap);

    body.appendChild(el('input', {
      class: 'input', style: 'font-size:12.5px;height:38px;margin-top:12px', readonly: 'readonly', value: url,
      onclick: (e) => e.currentTarget.select(),
    }));

    const row = el('div', { class: 'rowx', style: 'margin-top:10px;flex-wrap:wrap' },
      el('button', {
        class: 'mini', onclick: async () => {
          try { await navigator.clipboard.writeText(url); toast(t('link_copied')); }
          catch (_) { toast(url); }
        },
      }, t('copy_link')),
      el('button', { class: 'mini', onclick: () => qrDownload(url, `${a.title.replace(/[^\wЀ-ӿ -]/g, '').trim() || 'album'}-qr.svg`) },
        t('ev_qr_download')),
      el('button', { class: 'mini', onclick: () => printQr(a.title, url) }, t('ev_qr_print')));
    body.appendChild(row);

    body.appendChild(el('button', {
      class: 'mini', style: 'margin-top:14px;color:var(--muted)',
      onclick: async () => {
        if (!confirm(t('ev_link_reset_confirm'))) return;
        const { data, error } = await sb.rpc('event_link_reset', { p_album: a.id });
        if (error) { toast(error.message); return; }
        draw(data.token);
        toast(t('ev_link_reset_done'));
      },
    }, t('ev_link_reset')));
  };

  const { data, error } = await sb.rpc('event_link', { p_album: a.id });
  if (error) body.appendChild(el('div', { class: 'muted', text: error.message }));
  else draw(data.token);
  return box;
}

/** Печатная табличка «сканируйте и добавьте свои фото» — то, что ставят на стол. */
function printQr(title, url) {
  const w = window.open('', '_blank');
  if (!w) { toast(t('ev_popup_blocked')); return; }
  const svg = new XMLSerializer().serializeToString(qrSvg(url, 460));
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  w.document.write(`<!DOCTYPE html><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{margin:0;font-family:Inter,system-ui,sans-serif;color:#141414;background:#fff;
       display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{text-align:center;padding:48px}
  h1{font-size:40px;font-weight:800;letter-spacing:-.025em;margin:0 0 10px}
  p{font-size:20px;color:#4A4741;margin:0 0 28px}
  .u{font-size:14px;color:#9B978F;margin-top:22px;word-break:break-all}
  @media print{ .card{padding:0} }
</style>
<div class="card"><h1>${esc(title)}</h1><p>${esc(t('ev_print_call'))}</p>${svg}<div class="u">${esc(url)}</div></div>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

/* ---------------------------------------------------------------- настройки */

function settingsBox(a) {
  const box = el('div', { class: 'side-card', style: 'margin-top:18px' },
    el('div', { class: 'label', text: t('ev_settings') }));

  const title = el('input', { class: 'input', style: 'margin-top:10px', value: a.title, maxlength: '120' });
  const desc = el('textarea', { class: 'input', rows: '3', style: 'margin-top:10px;height:auto;padding:10px 14px',
    maxlength: '600', placeholder: t('ev_f_desc') });
  desc.value = a.description || '';

  const opts = [
    ['private', t('ev_vis_private'), t('ev_vis_private_d')],
    ['friends', t('ev_vis_friends'), t('ev_vis_friends_d')],
    ['public', t('ev_vis_public'), t('ev_vis_public_d')],
  ];
  let vis = a.visibility;
  const wrap = el('div', { class: 'vis-opts', style: 'margin-top:12px' });
  opts.forEach(([val, ttl, sub]) => {
    const input = el('input', { type: 'radio', name: 'evvis2', value: val, checked: val === vis ? 'checked' : null,
      onchange: () => { vis = val; wrap.querySelectorAll('.vis-opt').forEach(n => n.classList.toggle('on', n.contains(input) && input.checked)); } });
    wrap.appendChild(el('label', { class: 'vis-opt' + (val === vis ? ' on' : '') },
      input, el('div', {}, el('b', { text: ttl }), el('span', { text: sub }))));
  });

  const hold = el('input', { type: 'checkbox', checked: a.event_hold_guest ? 'checked' : null });
  const holdRow = el('label', { style: 'display:flex;gap:10px;align-items:flex-start;margin-top:14px;font-size:14.5px;line-height:1.45;cursor:pointer' },
    hold, el('div', {}, el('b', { text: t('ev_hold') }),
      el('div', { class: 'muted', style: 'font-size:13.5px;margin-top:2px', text: t('ev_hold_d') })));

  const save = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:16px' }, t('save_changes'));
  save.onclick = async () => {
    save.disabled = true;
    const patch = {
      title: title.value.trim() || a.title,
      description: desc.value.trim() || null,
      visibility: vis,
      event_hold_guest: hold.checked,
    };
    // Приватное событие живёт черновиком: в ленту ему всё равно нельзя, а очередь
    // модерации незачем забивать. Как только его открывают — публикуем.
    if (vis === 'private') patch.published_at = null;
    else if (!a.published_at) patch.published_at = new Date().toISOString();

    const { error } = await sb.from('albums').update(patch).eq('id', a.id);
    save.disabled = false;
    if (error) { toast(error.message); return; }
    toast(t('changes_saved'));
    location.reload();
  };

  box.append(title, desc, wrap, holdRow, save);
  return box;
}

/* ---------------------------------------------------------------- гости */

async function guestsBox(a) {
  const box = el('div', { class: 'side-card', style: 'margin-top:18px' },
    el('div', { class: 'label', text: t('ev_guests') }));
  const { data } = await sb.rpc('album_contributors', { p_album: a.id });
  const list = (data || []).filter(g => g.username);
  if (!list.length) {
    box.appendChild(el('div', { class: 'muted', style: 'font-size:14.5px;margin-top:8px', text: t('ev_no_guests') }));
    return box;
  }
  const stack = el('div', { class: 'stack', style: 'margin-top:10px' });
  list.forEach(g => {
    stack.appendChild(el('a', { href: `profile.html?u=${encodeURIComponent(g.username)}`,
      style: 'display:flex;gap:10px;align-items:center' },
      avatarImg(g.avatar, g.name, 34),
      el('div', { style: 'min-width:0' },
        el('div', { style: 'font-size:14.5px;font-weight:600', text: g.name || g.username }),
        el('div', { class: 'muted', style: 'font-size:13px', text: t('ev_uploaded_n', { count: g.uploaded || 0 }) }))));
  });
  box.appendChild(stack);
  return box;
}

/* ---------------------------------------------------------------- разбор фотографий */

async function mediaBox(host, data) {
  const a = data.album;
  const items = [
    ...(data.chapters || []).flatMap(c => c.media || []),
    ...(data.loose || []),
  ].filter(m => m.kind !== 'audio').sort((x, y) => (x.position ?? 0) - (y.position ?? 0));

  const head = el('div', { class: 'section-head', style: 'margin:0 0 6px' },
    el('h2', { text: t('ev_photos') }));
  host.appendChild(head);
  host.appendChild(el('p', { class: 'muted', style: 'margin:0 0 16px;font-size:14.5px;line-height:1.55', text: t('ev_photos_hint') }));

  if (!items.length) {
    host.appendChild(el('div', { class: 'side-card' },
      el('div', { style: 'font-size:16px;font-weight:600', text: t('ev_empty_title') }),
      el('div', { class: 'muted', style: 'font-size:14.5px;margin-top:6px', text: t('ev_empty_text') })));
    return;
  }

  const visOf = (m) => m.visibility || (m.is_private ? 'private' : 'all');
  const selected = new Set();
  let filter = 'all';

  /* фильтр по видимости */
  const counts = () => ({
    all: items.length,
    shown: items.filter(m => visOf(m) === 'all' || visOf(m) === 'public').length,
    friends: items.filter(m => visOf(m) === 'friends').length,
    hidden: items.filter(m => visOf(m) === 'private').length,
  });
  const filterRow = el('div', { class: 'chips', style: 'margin-bottom:14px' });
  host.appendChild(filterRow);

  /* панель массовых действий */
  const bulk = el('div', { class: 'ev-bulk hide' });
  const bulkCount = el('span', { style: 'font-weight:600' });
  const setVis = async (value) => {
    const ids = [...selected];
    if (!ids.length) return;
    const { error } = await sb.rpc('album_media_set_visibility', {
      p_ids: ids, p_visibility: value,
    });
    if (error) { toast(error.message); return; }
    items.forEach(m => { if (selected.has(m.am_id)) m.visibility = value; });
    selected.clear();
    draw();
    toast(t('ev_applied'));
  };
  bulk.append(bulkCount,
    el('div', { class: 'rowx', style: 'flex-wrap:wrap' },
      el('button', { class: 'mini', onclick: () => setVis(null) }, t('ev_set_all')),
      el('button', { class: 'mini', onclick: () => setVis('friends') }, t('ev_set_friends')),
      el('button', { class: 'mini', onclick: () => setVis('private') }, t('ev_set_hidden')),
      el('button', { class: 'mini', onclick: () => { selected.clear(); draw(); } }, t('ev_clear_sel'))));
  host.appendChild(bulk);

  const grid = el('div', { class: 'ev-grid' });
  host.appendChild(grid);

  const urls = await signUrls(items.flatMap(m => [m.thumb, m.path]));

  function draw() {
    /* чипы-фильтры */
    clear(filterRow);
    const c = counts();
    [['all', t('ev_flt_all'), c.all], ['shown', t('ev_flt_shown'), c.shown],
      ['friends', t('ev_flt_friends'), c.friends], ['hidden', t('ev_flt_hidden'), c.hidden]]
      .forEach(([key, label, n]) => {
        filterRow.appendChild(el('button', {
          class: 'chip' + (filter === key ? ' on' : ''),
          onclick: () => { filter = key; draw(); },
        }, `${label} · ${n}`));
      });

    /* панель выделения */
    bulk.classList.toggle('hide', selected.size === 0);
    bulkCount.textContent = t('ev_selected_n', { count: selected.size });

    /* плитки */
    clear(grid);
    const shown = items.filter(m => {
      const v = visOf(m);
      if (filter === 'all') return true;
      if (filter === 'shown') return v === 'all' || v === 'public';
      if (filter === 'friends') return v === 'friends';
      return v === 'private';
    });

    if (!shown.length) {
      grid.appendChild(el('div', { class: 'muted', style: 'grid-column:1/-1', text: t('ev_flt_empty') }));
      return;
    }

    shown.forEach(m => {
      const v = visOf(m);
      const on = selected.has(m.am_id);
      const cell = el('div', { class: 'ev-cell' + (on ? ' sel' : '') + (v === 'private' ? ' dim' : '') });

      const node = thumbEl(m.thumb || m.path, urls[m.thumb] || urls[m.path], m.thumb ? null : m.kind);
      if (node) cell.appendChild(node);
      if (m.kind === 'video') cell.appendChild(el('div', { class: 'tag', text: dur(m.duration) || t('video_tag') }));

      cell.appendChild(el('div', { class: 'ev-mark ' + v, text: visLabel(v) }));

      // клик по плитке — выделение; переключатель видимости отдельной кнопкой
      cell.onclick = (e) => {
        if (e.target.closest('.ev-quick')) return;
        if (selected.has(m.am_id)) selected.delete(m.am_id); else selected.add(m.am_id);
        draw();
      };

      const quick = el('div', { class: 'ev-quick' });
      [['all', t('ev_q_all')], ['friends', t('ev_q_friends')], ['private', t('ev_q_hidden')]]
        .forEach(([val, label]) => {
          quick.appendChild(el('button', {
            class: 'ev-q' + (v === val || (val === 'all' && v === 'public') ? ' on' : ''),
            title: label,
            onclick: async (e) => {
              e.stopPropagation();
              const { error } = await sb.rpc('album_media_set_visibility', {
                p_ids: [m.am_id], p_visibility: val === 'all' ? null : val,
              });
              if (error) { toast(error.message); return; }
              m.visibility = val === 'all' ? null : val;
              m.is_private = val === 'private' || val === 'friends';
              draw();
            },
          }, label));
        });
      cell.appendChild(quick);

      grid.appendChild(cell);
    });

    /* выделить всё в текущем фильтре */
    const allSel = shown.every(m => selected.has(m.am_id));
    grid.appendChild(el('button', {
      class: 'ev-selall',
      onclick: () => {
        shown.forEach(m => allSel ? selected.delete(m.am_id) : selected.add(m.am_id));
        draw();
      },
    }, allSel ? t('ev_unselect_all') : t('ev_select_all')));
  }

  function visLabel(v) {
    if (v === 'friends') return t('ev_q_friends');
    if (v === 'private') return t('ev_q_hidden');
    return t('ev_q_all');
  }

  draw();
}
