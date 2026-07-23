// Общий альбом события: постоянный QR для гостей + разбор того, что они залили.
//
// Две страницы в одном файле:
//   event.html          — список моих событий и создание нового (тратит квоту);
//   event.html?id=<uuid> — управление одним событием: обложка, слово гостям,
//                          QR, гости, разбор фотографий.
//
// Право на событие даёт квота event_quota.credits (её выдаёт админ после
// оплаты). Без квоты страница объясняет, что это, и ведёт на тариф.
import { sb, isAuthed } from './sb.js';
import {
  el, $, clear, mountShell, signUrls, toast, showLogin, emptyState, icon, t,
  dur, modal, avatarImg,
} from './ui.js';
import { qrSvg, qrDownload } from './qr.js';
import { uploadMedia } from './upload.js';

const app = $('#app');
const albumId = new URLSearchParams(location.search).get('id');

// Обложку меняют из двух мест — из своего блока и из просмотра фотографии.
// Чтобы картинка наверху не отставала, блок обложки оставляет здесь свою
// перерисовку.
let repaintCover = () => {};

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
  const credits = Number(cr) || 0;
  const albums = list || [];

  app.appendChild(el('div', { class: 'section-head', style: 'margin:0 0 6px' },
    el('h1', { style: 'font-size:30px;letter-spacing:-.02em', text: t('ev_title') })));
  app.appendChild(el('p', { class: 'lede', style: 'margin:0 0 24px;max-width:720px', text: t('ev_lede') }));

  const quota = el('div', { class: 'side-card', style: 'max-width:720px' });
  if (credits > 0) {
    quota.append(
      el('div', { class: 'label', text: t('ev_available') }),
      el('div', { style: 'font-size:32px;font-weight:800;letter-spacing:-.02em;margin-top:4px', text: String(credits) }),
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

  app.appendChild(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin-top:22px;max-width:1080px' },
    featureCard('ev_f1_t', 'ev_f1_d'), featureCard('ev_f2_t', 'ev_f2_d'), featureCard('ev_f3_t', 'ev_f3_d')));

  if (!albums.length) return;

  app.appendChild(el('div', { class: 'section-head', style: 'margin:40px 0 16px' }, el('h2', { text: t('ev_my') })));

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

    let vis = 'private';
    const wrap = visPicker('evvis', vis, (v) => { vis = v; });

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

function visPicker(name, initial, onPick) {
  const opts = [
    ['private', t('ev_vis_private'), t('ev_vis_private_d')],
    ['friends', t('ev_vis_friends'), t('ev_vis_friends_d')],
    ['public', t('ev_vis_public'), t('ev_vis_public_d')],
  ];
  const wrap = el('div', { class: 'vis-opts', style: 'margin-top:14px' });
  opts.forEach(([val, ttl, sub]) => {
    const input = el('input', {
      type: 'radio', name, value: val, checked: val === initial ? 'checked' : null,
      onchange: () => {
        onPick(val);
        wrap.querySelectorAll('.vis-opt').forEach(n => n.classList.toggle('on', n.contains(input) && input.checked));
      },
    });
    wrap.appendChild(el('label', { class: 'vis-opt' + (val === initial ? ' on' : '') },
      input, el('div', {}, el('b', { text: ttl }), el('span', { text: sub }))));
  });
  return wrap;
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
      el('span', { class: 'chip', style: 'pointer-events:none', text: statusText(a) }),
      el('a', { class: 'btn btn-ghost btn-sm', href: `album.html?id=${a.id}` }, t('ev_open_album')))));

  const cols = el('div', { class: 'album-cols' });
  const left = el('div', { style: 'min-width:0' });
  const right = el('aside', {});
  cols.append(left, right);
  app.appendChild(cols);

  await coverBox(left, a);
  right.append(await linkBox(a), settingsBox(a), await guestsBox(a));
  await mediaBox(left, data);
}

/* ---------------------------------------------------------------- обложка */

async function coverBox(host, a) {
  const box = el('div', { class: 'side-card', style: 'margin:0 0 28px;padding:0;overflow:hidden' });
  const stage = el('div', { class: 'ev-cover' });
  box.appendChild(stage);

  const body = el('div', { style: 'padding:16px 20px' });
  box.appendChild(body);
  host.appendChild(box);

  const paint = async (fresh) => {
    if (fresh) {
      const { data } = await sb.rpc('get_album', { p_id: a.id });
      if (data?.album) {
        a.cover_path = data.album.cover_path;
        a.cover_thumb = data.album.cover_thumb;
        a.cover_media_id = data.album.cover_media_id;
      }
    }
    clear(stage);
    if (a.cover_path || a.cover_thumb) {
      const u = await signUrls([a.cover_path, a.cover_thumb]);
      const src = u[a.cover_path] || u[a.cover_thumb];
      if (src) stage.appendChild(el('img', { src, alt: a.title }));
      else stage.appendChild(el('div', { class: 'ev-cover-empty', text: t('ev_cover_empty') }));
    } else {
      stage.appendChild(el('div', { class: 'ev-cover-empty' },
        el('div', { style: 'font-size:16px;font-weight:600', text: t('ev_cover_none') }),
        el('div', { class: 'muted', style: 'font-size:14px;margin-top:6px;max-width:460px;line-height:1.5',
          text: t('ev_cover_none_d') })));
    }
  };

  const file = el('input', {
    type: 'file', accept: 'image/*,.heic,.heif', class: 'hide',
    onchange: async (e) => {
      const f = e.currentTarget.files[0];
      e.currentTarget.value = '';
      if (!f) return;
      up.disabled = true;
      const old = up.textContent;
      up.textContent = t('ev_cover_uploading');
      try {
        const media = await uploadMedia(f);
        const { error } = await sb.rpc('album_set_cover_media', { p_album: a.id, p_media: media.id });
        if (error) throw error;
        a.cover_path = media.storage_path;
        a.cover_thumb = media.thumb_path || media.storage_path;
        await paint();
        toast(t('ev_cover_set'));
      } catch (err) {
        toast(err.message || t('upload_failed'));
      }
      up.textContent = old;
      up.disabled = false;
    },
  });
  const up = el('button', { class: 'btn btn-ghost btn-sm', onclick: () => file.click() }, t('ev_cover_upload'));

  body.append(
    el('div', { class: 'label', text: t('ev_cover') }),
    el('div', { class: 'muted', style: 'font-size:14px;line-height:1.5;margin:6px 0 12px', text: t('ev_cover_hint') }),
    el('div', { class: 'rowx' }, up, file));
  repaintCover = () => paint(true);
  await paint();
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

    body.appendChild(el('div', { class: 'rowx', style: 'margin-top:10px;flex-wrap:wrap' },
      el('button', {
        class: 'mini', onclick: async () => {
          try { await navigator.clipboard.writeText(url); toast(t('link_copied')); }
          catch (_) { toast(url); }
        },
      }, t('copy_link')),
      el('button', { class: 'mini', onclick: () => qrDownload(url, `${safeName(a.title)}-qr.svg`) }, t('ev_qr_download')),
      el('button', { class: 'mini', onclick: () => printQr(a.title, url) }, t('ev_qr_print'))));

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

const safeName = (s) => String(s).replace(/[^\wЀ-ӿ -]/g, '').trim() || 'album';

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

  const greet = el('textarea', { class: 'input', rows: '4', style: 'margin-top:6px;height:auto;padding:10px 14px',
    maxlength: '1200', placeholder: t('ev_greeting_ph') });
  greet.value = a.event_greeting || '';

  let vis = a.visibility;
  const wrap = visPicker('evvis2', vis, (v) => { vis = v; });

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
      event_greeting: greet.value.trim() || null,
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

  box.append(title, desc,
    el('div', { class: 'label', style: 'margin-top:16px', text: t('ev_greeting') }),
    el('div', { class: 'muted', style: 'font-size:13.5px;line-height:1.45;margin-top:4px', text: t('ev_greeting_d') }),
    greet, wrap, holdRow, save);
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
    const rel = g.is_friend ? t('ev_rel_friend') : (g.is_follower ? t('ev_rel_follower') : t('ev_rel_guest'));
    stack.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:center' },
      el('a', { href: `profile.html?u=${encodeURIComponent(g.username)}`, style: 'flex-shrink:0' },
        avatarImg(g.avatar, g.name, 36)),
      el('div', { style: 'min-width:0;flex:1' },
        el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
          el('a', { href: `profile.html?u=${encodeURIComponent(g.username)}`,
            style: 'font-size:14.5px;font-weight:600', text: g.name || g.username }),
          el('span', { class: 'ev-rel' + (g.is_friend ? ' friend' : g.is_follower ? ' follower' : ''), text: rel })),
        el('div', { class: 'muted', style: 'font-size:13px;margin-top:2px',
          text: t('ev_guest_stat', { total: g.uploaded || 0, shown: g.shown || 0, held: g.held || 0 }) }))));
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

  host.appendChild(el('div', { class: 'section-head', style: 'margin:0 0 6px' }, el('h2', { text: t('ev_photos') })));
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
  let byUser = null;          // username или null = все
  let order = false;          // режим «порядок публикации»

  const filterRow = el('div', { class: 'chips', style: 'margin-bottom:10px' });
  const userRow = el('div', { class: 'chips', style: 'margin-bottom:14px' });
  host.append(filterRow, userRow);

  /* панель массовых действий */
  const bulk = el('div', { class: 'ev-bulk hide' });
  const bulkCount = el('span', { style: 'font-weight:600' });
  const setVis = async (value, ids) => {
    const list = ids || [...selected];
    if (!list.length) return;
    const { error } = await sb.rpc('album_media_set_visibility', { p_ids: list, p_visibility: value });
    if (error) { toast(error.message); return; }
    items.forEach(m => {
      if (!list.includes(m.am_id)) return;
      m.visibility = value;
      m.is_private = value === 'private' || value === 'friends';
    });
    if (!ids) selected.clear();
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

  /* ---- превью плитки: если превью не отдалось, пробуем оригинал ---- */
  function tileMedia(m) {
    const th = urls[m.thumb], full = urls[m.path];
    if (!th && !full) {
      return el('div', { class: 'ev-broken' },
        el('div', { text: t('ev_no_preview') }),
        el('div', { style: 'font-size:11px;opacity:.7;margin-top:3px', text: t('ev_no_preview_d') }));
    }
    if (m.kind === 'video') {
      const v = el('video', { preload: 'metadata', muted: 'muted', playsinline: 'playsinline', tabindex: '-1' });
      v.controls = false;
      v.src = (full || th) + '#t=0.1';
      return v;
    }
    const img = el('img', { alt: m.caption || '', loading: 'lazy' });
    img.src = th || full;
    // Превью и оригинал лежат в R2 разными объектами: если превью не доехало,
    // молча показываем оригинал вместо пустого серого квадрата.
    if (th && full) img.onerror = () => { img.onerror = null; img.src = full; };
    return img;
  }

  const contributors = () => {
    const map = new Map();
    items.forEach(m => {
      const u = m.by?.username || '—';
      const cur = map.get(u) || { username: m.by?.username, name: m.by?.name || m.by?.username, n: 0 };
      cur.n++;
      map.set(u, cur);
    });
    return [...map.values()].sort((x, y) => y.n - x.n);
  };

  function visible() {
    return items.filter(m => {
      const v = visOf(m);
      if (byUser && m.by?.username !== byUser) return false;
      if (filter === 'shown') return v === 'all' || v === 'public';
      if (filter === 'friends') return v === 'friends';
      if (filter === 'hidden') return v === 'private';
      return true;
    });
  }

  function visLabel(v) {
    if (v === 'friends') return t('ev_q_friends');
    if (v === 'private') return t('ev_q_hidden');
    return t('ev_q_all');
  }

  /* ---- просмотр во весь экран: тут же видно, кто прислал, и меняется видимость ---- */
  function openViewer(startId) {
    const list = visible();
    let i = Math.max(0, list.findIndex(m => m.am_id === startId));

    const stage = el('div', { class: 'ev-view-stage' });
    const meta = el('div', { class: 'ev-view-meta' });
    const ctl = el('div', { class: 'ev-view-ctl' });

    const paint = () => {
      const m = list[i];
      clear(stage); clear(meta); clear(ctl);

      const src = urls[m.path] || urls[m.thumb];
      if (!src) stage.appendChild(el('div', { class: 'ev-broken', text: t('ev_no_preview') }));
      else if (m.kind === 'video') {
        const v = el('video', { src, controls: 'controls', playsinline: 'playsinline', autoplay: 'autoplay' });
        stage.appendChild(v);
      } else stage.appendChild(el('img', { src, alt: m.caption || '' }));

      meta.append(
        avatarImg(m.by?.avatar, m.by?.name, 32),
        el('div', { style: 'min-width:0' },
          el('div', { style: 'font-size:14.5px;font-weight:600', text: m.by?.name || m.by?.username || t('ev_unknown_guest') }),
          el('div', { style: 'font-size:12.5px;opacity:.7', text: `${i + 1} / ${list.length}${m.caption ? ' · ' + m.caption : ''}` })));

      const v = visOf(m);
      [['all', t('ev_q_all')], ['friends', t('ev_q_friends')], ['private', t('ev_q_hidden')]].forEach(([val, label]) => {
        ctl.appendChild(el('button', {
          class: 'ev-vbtn' + (v === val || (val === 'all' && v === 'public') ? ' on' : ''),
          onclick: async () => { await setVis(val === 'all' ? null : val, [m.am_id]); paint(); },
        }, label));
      });
      ctl.appendChild(el('button', {
        class: 'ev-vbtn' + (a.cover_media_id === m.id ? ' on' : ''), onclick: async () => {
          const { error } = await sb.rpc('album_set_cover', { p_am_id: m.am_id });
          if (error) { toast(error.message); return; }
          a.cover_media_id = m.id;
          await repaintCover();
          paint();
          toast(t('ev_cover_set'));
        },
      }, t('ev_make_cover')));
    };

    const step = (d) => { i = (i + d + list.length) % list.length; paint(); };
    const nav = (d) => el('button', { class: 'ev-view-nav ' + (d < 0 ? 'prev' : 'next'), onclick: () => step(d) },
      icon(d < 0 ? 'chevL' : 'chevR', 22, { stroke: '#141414', sw: 2 }));

    const overlay = el('div', { class: 'ev-view', onclick: (e) => { if (e.target === overlay) close(); } },
      el('button', { class: 'ev-view-x', onclick: () => close(), text: '✕' }),
      stage,
      el('div', { class: 'ev-view-bar' },
        list.length > 1 ? nav(-1) : null, meta, ctl, list.length > 1 ? nav(1) : null));

    function key(e) {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    }
    function close() { document.removeEventListener('keydown', key); overlay.remove(); draw(); }

    document.addEventListener('keydown', key);
    document.body.appendChild(overlay);
    paint();
  }

  async function move(m, d) {
    const shown = visible();
    const idx = shown.findIndex(x => x.am_id === m.am_id);
    const to = idx + d;
    if (to < 0 || to >= shown.length) return;
    [shown[idx], shown[to]] = [shown[to], shown[idx]];
    // порядок задаём по всему альбому, а не по текущему фильтру: иначе позиции
    // отфильтрованных файлов разъехались бы с видимыми
    const rest = items.filter(x => !shown.some(s => s.am_id === x.am_id));
    const finalOrder = [...shown, ...rest];
    finalOrder.forEach((x, k) => { x.position = k; });
    items.sort((x, y) => x.position - y.position);
    draw();
    const { error } = await sb.rpc('album_media_reorder', { p_ids: finalOrder.map(x => x.am_id) });
    if (error) toast(error.message);
  }

  function draw() {
    /* чипы: видимость */
    clear(filterRow);
    const pool = byUser ? items.filter(m => m.by?.username === byUser) : items;
    const c = {
      all: pool.length,
      shown: pool.filter(m => ['all', 'public'].includes(visOf(m))).length,
      friends: pool.filter(m => visOf(m) === 'friends').length,
      hidden: pool.filter(m => visOf(m) === 'private').length,
    };
    [['all', t('ev_flt_all'), c.all], ['shown', t('ev_flt_shown'), c.shown],
      ['friends', t('ev_flt_friends'), c.friends], ['hidden', t('ev_flt_hidden'), c.hidden]]
      .forEach(([key, label, n]) => {
        filterRow.appendChild(el('button', {
          class: 'chip' + (filter === key ? ' on' : ''),
          onclick: () => { filter = key; draw(); },
        }, `${label} · ${n}`));
      });
    filterRow.appendChild(el('button', {
      class: 'chip' + (order ? ' on' : ''),
      onclick: () => { order = !order; draw(); },
    }, t('ev_order_mode')));

    /* чипы: кто прислал */
    clear(userRow);
    const cons = contributors();
    if (cons.length > 1 || (cons.length === 1 && cons[0].username)) {
      userRow.appendChild(el('button', {
        class: 'chip' + (byUser === null ? ' on' : ''),
        onclick: () => { byUser = null; draw(); },
      }, `${t('ev_by_all')} · ${items.length}`));
      cons.forEach(u => {
        userRow.appendChild(el('button', {
          class: 'chip' + (byUser === u.username ? ' on' : ''),
          onclick: () => { byUser = byUser === u.username ? null : u.username; draw(); },
        }, `${u.name || t('ev_unknown_guest')} · ${u.n}`));
      });
    }

    /* панель выделения */
    bulk.classList.toggle('hide', selected.size === 0);
    bulkCount.textContent = t('ev_selected_n', { count: selected.size });

    /* плитки */
    clear(grid);
    const shown = visible();
    if (!shown.length) {
      grid.appendChild(el('div', { class: 'muted', style: 'grid-column:1/-1', text: t('ev_flt_empty') }));
      return;
    }

    shown.forEach((m, idx) => {
      const v = visOf(m);
      const on = selected.has(m.am_id);
      const isCover = a.cover_media_id && m.id === a.cover_media_id;
      const cell = el('div', {
        class: 'ev-cell' + (on ? ' sel' : '') + (v === 'private' ? ' dim' : ''),
        title: t('ev_open_photo'),
        onclick: (e) => { if (!e.target.closest('.ev-quick,.ev-pick,.ev-move')) openViewer(m.am_id); },
      });

      cell.appendChild(tileMedia(m));
      if (m.kind === 'video') cell.appendChild(el('div', { class: 'tag', text: dur(m.duration) || t('video_tag') }));

      cell.appendChild(el('button', {
        class: 'ev-pick' + (on ? ' on' : ''), 'aria-label': t('ev_select'),
        onclick: () => { on ? selected.delete(m.am_id) : selected.add(m.am_id); draw(); },
      }, on ? '✓' : ''));

      cell.appendChild(el('div', { class: 'ev-mark ' + v, text: isCover ? t('ev_is_cover') : visLabel(v) }));

      if (order) {
        cell.appendChild(el('div', { class: 'ev-move' },
          el('button', { disabled: idx === 0 ? 'disabled' : null, onclick: () => move(m, -1) }, '←'),
          el('span', { text: String(idx + 1) }),
          el('button', { disabled: idx === shown.length - 1 ? 'disabled' : null, onclick: () => move(m, 1) }, '→')));
      } else {
        const quick = el('div', { class: 'ev-quick' });
        [['all', t('ev_q_all')], ['friends', t('ev_q_friends')], ['private', t('ev_q_hidden')]].forEach(([val, label]) => {
          quick.appendChild(el('button', {
            class: 'ev-q' + (v === val || (val === 'all' && v === 'public') ? ' on' : ''),
            onclick: () => setVis(val === 'all' ? null : val, [m.am_id]),
          }, label));
        });
        cell.appendChild(quick);
      }

      if (m.by?.name || m.by?.username) {
        cell.appendChild(el('div', { class: 'ev-by', text: m.by.name || m.by.username }));
      }

      grid.appendChild(cell);
    });

    const allSel = shown.every(m => selected.has(m.am_id));
    grid.appendChild(el('button', {
      class: 'ev-selall',
      onclick: () => { shown.forEach(m => allSel ? selected.delete(m.am_id) : selected.add(m.am_id)); draw(); },
    }, allSel ? t('ev_unselect_all') : t('ev_select_all')));
  }

  draw();
}
