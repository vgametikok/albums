// Панель модерации. Отдельная страница, вход по паролю (проверяется в edge-функции
// mod-api). Пользовательская авторизация Albums тут ни при чём — у модератора своя.
// Токен сессии живёт в sessionStorage: закрыл вкладку — вышел.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { el, clear, icon, toast, composition, avatarImg, timeAgo } from './ui.js';
import { renderStory, audioRow } from './albumview.js';

const API = `${SUPABASE_URL}/functions/v1/mod-api`;
const app = document.getElementById('app');
let token = sessionStorage.getItem('modToken') || null;

async function call(action, extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };
  if (token) headers['X-Mod-Token'] = token;
  const resp = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ action, ...extra }) });
  const json = await resp.json().catch(() => ({}));
  if (resp.status === 401 && action !== 'login') { logout(); throw new Error('session expired'); }
  if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
  return json;
}

function logout() {
  token = null;
  sessionStorage.removeItem('modToken');
  renderLogin();
}

/* ---------------- вход ---------------- */
function renderLogin() {
  clear(app);
  const login = el('input', { class: 'input', placeholder: 'login', autocomplete: 'off' });
  const pass = el('input', { class: 'input', type: 'password', placeholder: 'password', style: 'margin-top:10px' });
  const err = el('div', { class: 'muted', style: 'color:#B3452F;margin-top:10px;min-height:20px' });
  const btn = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:14px' }, 'Enter');

  btn.onclick = async () => {
    btn.disabled = true; err.textContent = '';
    try {
      const r = await call('login', { login: login.value, password: pass.value });
      token = r.token;
      sessionStorage.setItem('modToken', token);
      start();
    } catch (e) {
      err.textContent = e.message === 'too_many' ? 'Too many attempts, wait 15 min' : 'Wrong login or password';
      btn.disabled = false;
    }
  };
  pass.onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };

  app.appendChild(el('div', { style: 'max-width:360px;margin:60px auto' },
    el('h1', { style: 'font-size:28px;font-weight:800;margin:0 0 6px', text: 'Moderation' }),
    el('p', { class: 'muted', style: 'margin:0 0 20px', text: 'Restricted area' }),
    login, pass, err, btn));
}

/* ---------------- общая шапка ---------------- */
function head(title, active) {
  return el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px;flex-wrap:wrap' },
    el('h1', { style: 'font-size:26px;font-weight:800;margin:0', text: title }),
    el('div', { class: 'rowx' },
      el('button', {
        class: 'chip btn-sm' + (active ==='queue' ? ' on' : ''),
        onclick: () => renderQueue(),
      }, 'Reports'),
      el('button', {
        id: 'tab-pending',
        class: 'chip btn-sm' + (active ==='pending' ? ' on' : ''),
        onclick: () => renderPending(),
      }, pendingLabel()),
      el('button', {
        id: 'tab-media',
        class: 'chip btn-sm' + (active ==='media' ? ' on' : ''),
        onclick: () => renderMedia(),
      }, mediaLabel()),
      el('button', {
        class: 'chip btn-sm' + (active ==='ralbums' ? ' on' : ''),
        onclick: () => renderRecentAlbums(),
      }, 'Recent albums'),
      el('button', {
        class: 'chip btn-sm' + (active ==='rmedia' ? ' on' : ''),
        onclick: () => renderRecentMedia(),
      }, 'Recent media'),
      el('button', {
        class: 'chip btn-sm' + (active ==='users' ? ' on' : ''),
        onclick: () => renderUsers(),
      }, 'Users'),
      el('button', {
        class: 'chip btn-sm' + (active ==='stats' ? ' on' : ''),
        onclick: () => renderStats(),
      }, 'Statistics'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: logout }, 'Sign out')));
}

/* ---------------- очередь ---------------- */
async function renderQueue() {
  clear(app);
  app.appendChild(head('Reports', 'queue'));

  const list = el('div', { class: 'stack' });
  app.appendChild(list);
  list.appendChild(el('div', { class: 'muted', text: 'Loading…' }));

  let data;
  try { data = (await call('queue')).data; }
  catch (e) { clear(list).appendChild(el('div', { class: 'muted', text: e.message })); return; }

  const items = data || [];
  clear(list);
  if (!items.length) {
    list.appendChild(el('div', { class: 'empty' }, el('h3', { text: 'Queue is empty' }),
      el('div', { text: 'No open reports right now.' })));
    return;
  }
  items.forEach(r => list.appendChild(reportCard(r)));
}

function reportCard(r) {
  const tgt = r.target || {};
  const card = el('div', { class: 'side-card', style: 'display:flex;flex-direction:column;gap:10px' });

  const head = el('div', { style: 'display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap' },
    el('div', {},
      el('b', { text: `${r.subject_type} · ${r.reason}` }),
      el('div', { class: 'muted', style: 'font-size:13.5px', text: `reported by @${r.reporter?.username} · ${r.reports_on_subject} report(s)` })),
    tgt.hidden || tgt.banned
      ? el('span', { class: 'badge', style: 'position:static', text: tgt.banned ? 'BANNED' : 'HIDDEN' })
      : null);
  card.appendChild(head);

  if (r.note) card.appendChild(el('div', { style: 'font-size:14.5px', text: `“${r.note}”` }));
  card.appendChild(el('div', { class: 'muted', style: 'font-size:14px', text: describeTarget(r) }));

  const actions = el('div', { class: 'rowx' });
  actions.appendChild(el('button', { class: 'mini', onclick: () => openSubject(r) }, 'Open'));
  if (r.subject_type !== 'profile') {
    actions.appendChild(el('button', {
      class: 'mini', onclick: () => act('hide', { subject_type: r.subject_type, subject_id: r.subject_id, hide: !tgt.hidden }, card),
    }, tgt.hidden ? 'Unhide' : 'Hide'));
  }
  if (r.subject_type === 'profile') {
    actions.appendChild(el('button', {
      class: 'mini danger', onclick: () => act('ban', { user_id: r.subject_id, ban: !tgt.banned }, card),
    }, tgt.banned ? 'Unban' : 'Ban author'));
  }
  actions.append(
    el('button', { class: 'mini', onclick: () => resolve(r, 'resolved', card) }, 'Resolve'),
    el('button', { class: 'mini', onclick: () => resolve(r, 'rejected', card) }, 'Reject'));
  card.appendChild(actions);
  return card;
}

function describeTarget(r) {
  const t = r.target || {};
  if (r.subject_type === 'album') return `“${t.title}” by @${t.author} · ${t.visibility}`;
  if (r.subject_type === 'post') return `${t.caption || '(no caption)'} by @${t.author}`;
  if (r.subject_type === 'comment') return `“${t.body}” by @${t.author}`;
  if (r.subject_type === 'profile') return `@${t.username} (${t.name || ''})`;
  return '';
}

async function act(action, payload, card) {
  try {
    await call(action, payload);
    toast('Done');
    renderQueue();
  } catch (e) { toast(e.message); }
}

async function resolve(r, status, card) {
  try {
    await call('resolve', { report_id: r.id, status });
    toast(status === 'resolved' ? 'Resolved' : 'Rejected');
    card.style.opacity = '0.4';
    setTimeout(renderQueue, 400);
  } catch (e) { toast(e.message); }
}

/* ---------------- просмотр спорного контента ---------------- */
async function openSubject(r) {
  // Альбом смотрим целиком в вёрстке сайта, а не плиткой превью.
  if (r.subject_type === 'album') { openAlbum(r.subject_id); return; }
  let sub;
  try { sub = (await call('open', { subject_type: r.subject_type, subject_id: r.subject_id })).data; }
  catch (e) { toast(e.message); return; }
  if (!sub || sub.error) { toast('Not found'); return; }

  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } });
  const box = el('div', { class: 'modal wide' });
  bg.appendChild(box);

  box.appendChild(el('h2', { text: `${sub.type} — @${sub.author || sub.username}` }));
  if (sub.title) box.appendChild(el('div', { style: 'font-size:17px;font-weight:700', text: sub.title }));
  if (sub.description) box.appendChild(el('p', { text: sub.description }));
  if (sub.caption) box.appendChild(el('p', { text: sub.caption }));
  if (sub.body) box.appendChild(el('p', { text: sub.body }));
  if (sub.bio) box.appendChild(el('p', { class: 'muted', text: sub.bio }));

  const media = sub.media || [];
  if (media.length) {
    const grid = el('div', { class: 'lib-grid' });
    box.appendChild(grid);
    // подписанные URL — через ту же функцию под service-ключом
    const paths = media.map(m => m.thumb || m.path);
    try {
      const signed = (await call('sign', { paths })).data || [];
      const byPath = {};
      signed.forEach(s => { if (s.signedUrl) byPath[s.path] = s.signedUrl; });
      media.forEach(m => {
        const url = byPath[m.thumb] || byPath[m.path];
        const cell = el('div', { class: 'lib-cell' });
        if (url) {
          if (m.kind === 'video') cell.appendChild(el('video', { src: url + '#t=0.1', muted: 'muted', playsinline: 'playsinline' }));
          else cell.appendChild(el('img', { src: url, alt: '' }));
        }
        grid.appendChild(cell);
      });
    } catch (_) { grid.appendChild(el('div', { class: 'muted', text: 'media unavailable' })); }
  }

  box.appendChild(el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:16px', onclick: () => bg.remove() }, 'Close'));
  document.body.appendChild(bg);
}

/* ---------------- новые альбомы на проверке ---------------- */
// Каждый альбом, опубликованный автором, ждёт здесь решения и посторонним не
// виден. Одобренный уходит в ленту, отклонённый остаётся у автора с пометкой.
let pendingCount = null;
const pendingLabel = () => (pendingCount ? `New albums (${pendingCount})` : 'New albums');

async function renderPending() {
  clear(app);
  app.appendChild(head('New albums', 'pending'));

  const list = el('div', { class: 'stack' });
  app.appendChild(list);
  list.appendChild(el('div', { class: 'muted', text: 'Loading…' }));

  let d;
  try { d = (await call('pending')).data; }
  catch (e) { clear(list).appendChild(el('div', { class: 'muted', text: e.message })); return; }

  // Шапка рисуется до запроса, поэтому число в ярлыке обновляем уже по ответу —
  // иначе оно отстаёт на одно решение.
  pendingCount = d?.count ?? 0;
  const tab = document.getElementById('tab-pending');
  if (tab) tab.textContent = pendingLabel();
  const items = d?.albums || [];
  clear(list);
  if (!items.length) {
    list.appendChild(el('div', { class: 'empty' },
      el('h3', { text: 'Albums are not reviewed any more' }),
      el('div', { text: 'Since migration 058 a published album is approved automatically (you still get the Telegram message). Only files are reviewed — see New media.' }),
      el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn btn-ghost btn-sm', onclick: () => renderMedia() }, 'Open New media'))));
    return;
  }
  items.forEach(a => list.appendChild(pendingCard(a)));
}

function pendingCard(a) {
  const card = el('div', { class: 'side-card', style: 'display:flex;flex-direction:column;gap:10px' });
  card.appendChild(el('div', { style: 'display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap' },
    el('div', {},
      el('b', { text: a.title || '(no title)' }),
      el('div', { class: 'muted', style: 'font-size:13.5px',
        text: `@${a.author} · ${a.visibility} · ${a.photos || 0}p ${a.videos || 0}v ${a.audio || 0}a` })),
    a.author_banned ? el('span', { class: 'badge', style: 'position:static', text: 'AUTHOR BANNED' }) : null,
    a.reports ? el('span', { class: 'badge', style: 'position:static', text: `${a.reports} report(s)` }) : null));

  if (a.description) card.appendChild(el('div', { style: 'font-size:14.5px', text: a.description }));

  const note = el('input', { class: 'input', placeholder: 'Reason (sent to the author on reject)', autocomplete: 'off' });
  card.appendChild(note);

  const decide = async (approve) => {
    try {
      await call('review', { album_id: a.id, approve, note: note.value.trim() || null });
      toast(approve ? 'Approved' : 'Rejected');
      card.style.opacity = '0.4';
      setTimeout(renderPending, 400);
    } catch (e) { toast(e.message); }
  };

  card.appendChild(el('div', { class: 'rowx' },
    el('button', { class: 'mini', onclick: () => openAlbum(a.id) }, 'Open'),
    el('button', { class: 'mini', onclick: () => decide(true) }, 'Approve'),
    el('button', { class: 'mini danger', onclick: () => decide(false) }, 'Reject')));
  return card;
}

/* ---------------- новые медиа: единственная очередь проверки ---------------- */
// 058: альбомы одобряются при публикации сами, проверяются только файлы.
// Сюда попадает КАЖДЫЙ новый кадр (автор, соавтор, гость события) и обложки,
// загруженные отдельно от кадров. Пока файл ждёт решения, посторонние его не
// видят. Approve — показать; Hide — оставить скрытым (загрузивший видит своё).
// Лента приходит уже упорядоченной по альбомам — здесь только раскладываем
// её по группам, чтобы было видно, чей это альбом и где он лежит.
let mediaCount = null;
const mediaLabel = () => (mediaCount ? `New media (${mediaCount})` : 'New media');
const albumHref = (id) => `album.html?id=${encodeURIComponent(id)}`;
const albumModHref = (id) => `moderation.html?album=${encodeURIComponent(id)}`;

async function renderMedia(focusAlbum = null) {
  clear(app);
  app.appendChild(head('New media', 'media'));

  const list = el('div', {});
  app.appendChild(list);
  list.appendChild(el('div', { class: 'muted', text: 'Loading…' }));

  let d;
  try { d = (await call('media_pending', { limit: 200 })).data; }
  catch (e) { clear(list).appendChild(el('div', { class: 'muted', text: e.message })); return; }

  mediaCount = d?.count ?? 0;
  const tab = document.getElementById('tab-media');
  if (tab) tab.textContent = mediaLabel();

  const items = d?.items || [];
  clear(list);
  if (!items.length) {
    list.appendChild(el('div', { class: 'empty' },
      el('h3', { text: 'Nothing to review' }),
      el('div', { text: 'Every uploaded file has been reviewed.' })));
    return;
  }

  // порядок групп — как пришёл (альбом с самым старым ожидающим файлом первым)
  const groups = new Map();
  items.forEach(m => {
    if (!groups.has(m.album_id)) groups.set(m.album_id, []);
    groups.get(m.album_id).push(m);
  });

  list.appendChild(el('div', { class: 'muted', style: 'font-size:13.5px;margin:-6px 0 14px',
    text: `${mediaCount} file${mediaCount === 1 ? '' : 's'} waiting in ${groups.size} album${groups.size === 1 ? '' : 's'}`
      + (mediaCount > items.length ? ` · showing the first ${items.length}` : '')
      + ' · hidden from the public until approved' }));

  const urls = await signPaths(items.flatMap(m => [m.thumb, m.path]));
  let focusNode = null;
  for (const [albumId, ms] of groups) {
    const g = albumGroup(ms, urls, focusAlbum);
    if (albumId === focusAlbum) focusNode = g;
    list.appendChild(g);
  }
  if (focusNode) focusNode.scrollIntoView({ block: 'start' });
}

/** Шапка группы: какой альбом, чей, где открыть; ниже — его файлы. */
function albumGroup(ms, urls, focusAlbum) {
  const a = ms[0];
  const owner = a.album_owner;
  const chip = (text, warn) => el('span', { class: 'prov' + (warn ? ' warn' : ''), text });
  const waiting = a.album_open ?? ms.length;

  const approveAll = el('button', { class: 'mini', title: 'Approve every file of this album shown below' },
    `Approve all ${ms.length}`);
  approveAll.onclick = async () => {
    if (!confirm(`Approve ${ms.length} file(s) in “${a.album_title || 'album'}”?`)) return;
    approveAll.disabled = true;
    let done = 0;
    for (const m of ms) {
      try { await call('media_review', { am_id: m.am_id, approve: true }); done++; }
      catch (e) { toast(e.message); break; }
    }
    toast(`Approved ${done}`);
    renderMedia(a.album_id);
  };

  const box = el('section', {
    class: 'side-card mq-group' + (a.album_id === focusAlbum ? ' mq-focus' : ''),
    id: `mq-${a.album_id}`, 'data-album': a.album_id,
  });
  box.appendChild(el('div', { class: 'mq-head' },
    el('div', { class: 'mq-info' },
      el('div', { class: 'mq-kicker', text: 'ALBUM' }),
      el('a', { class: 'mq-title', href: albumHref(a.album_id), target: '_blank', rel: 'noopener',
        text: a.album_title || '(untitled album)' }),
      el('div', { class: 'mq-meta' },
        el('span', { class: 'muted', text: 'by ' }),
        owner
          ? el('a', { href: profileHref(owner), target: '_blank', rel: 'noopener', style: linkStyle, text: `@${owner}` })
          : el('span', { text: '—' }),
        a.album_owner_name && a.album_owner_name !== owner ? el('span', { class: 'muted', text: ` (${a.album_owner_name})` }) : null,
        el('span', { class: 'muted', text: ` · ${waiting} waiting${a.album_files != null ? ` of ${a.album_files} file${a.album_files === 1 ? '' : 's'}` : ''}` })),
      el('div', { style: 'display:flex;gap:4px;flex-wrap:wrap;margin-top:6px' },
        a.is_event ? chip('Event') : null,
        a.album_published === false ? chip('Draft', true) : (a.album_published ? chip('Published') : null),
        a.album_visibility && a.album_visibility !== 'public' ? chip(VIS_LABEL[a.album_visibility] || a.album_visibility) : null,
        a.album_status === 'rejected' ? chip('Album rejected', true) : null,
        a.reports ? chip(`${a.reports} report${a.reports === 1 ? '' : 's'}`, true) : null),
      a.album_description
        ? el('div', { class: 'mq-desc', title: 'Album text is not reviewed — shown here for a quick glance' },
          el('span', { class: 'muted', text: 'Album text: ' }), a.album_description)
        : null),
    el('div', { class: 'mq-links' },
      el('a', { class: 'btn btn-ghost btn-sm', href: albumHref(a.album_id), target: '_blank', rel: 'noopener' }, 'Public page ↗'),
      el('a', { class: 'btn btn-ghost btn-sm', href: albumModHref(a.album_id), target: '_blank', rel: 'noopener' }, 'Moderate ↗'),
      owner ? el('button', { class: 'btn btn-ghost btn-sm', onclick: () => renderUserAlbums(owner, () => renderMedia(a.album_id)) }, `@${owner}’s albums`) : null,
      approveAll)));

  const grid = el('div', { class: 'mq-grid' });
  ms.forEach(m => grid.appendChild(mediaCard(m, urls)));
  box.appendChild(grid);
  return box;
}

function mediaCard(m, urls) {
  const card = el('div', { class: 'mq-card' });

  const stage = el('div', { style: 'position:relative;border-radius:12px;overflow:hidden;background:#EFEDE8;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;cursor:zoom-in' });
  const src = urls[m.thumb] || urls[m.path];
  if (src) {
    if (m.kind === 'video') stage.appendChild(el('video', { src: (urls[m.path] || src) + '#t=0.1', muted: 'muted', playsinline: 'playsinline', controls: 'controls', style: 'width:100%;height:100%;object-fit:contain' }));
    else if (m.kind === 'audio') stage.appendChild(el('audio', { src: urls[m.path] || src, controls: 'controls', style: 'width:92%' }));
    else stage.appendChild(el('img', { src, alt: '', style: 'width:100%;height:100%;object-fit:cover' }));
  } else stage.appendChild(el('div', { class: 'muted', text: 'no preview' }));
  if (m.kind === 'photo') {
    stage.onclick = () => { const u = urls[m.path] || urls[m.thumb]; if (u) window.open(u, '_blank', 'noopener'); };
  }
  if (m.item === 'cover') stage.appendChild(el('span', { class: 'mq-badge', text: 'ALBUM COVER' }));
  card.appendChild(stage);

  const who = m.uploader_guest ? 'guest (no sign-in)' : `@${m.uploader || '?'}`;
  const role = m.item === 'cover' ? 'album cover' : (m.uploader_is_author ? 'author' : (m.uploader_guest ? null : 'not the author'));
  card.appendChild(el('div', {},
    // альбом — и на самой карточке: её содержимое понятно без шапки группы
    el('a', { class: 'mq-card-album', href: albumHref(m.album_id), target: '_blank', rel: 'noopener',
      title: `Open “${m.album_title || 'album'}” in a new tab`, text: `📁 ${m.album_title || '(album)'}` }),
    el('div', { class: 'muted', style: 'font-size:13px',
      text: `by ${who}${role ? ` (${role})` : ''}${m.anon ? ' · anon' : ''}${m.is_private ? ' · owner keeps it private' : ''} · ${timeAgo(m.added_at)}` }),
    m.caption ? el('div', { style: 'font-size:13.5px;margin-top:4px', text: `“${m.caption}”` }) : null));

  const decide = async (approve) => {
    try {
      await call('media_review', { am_id: m.am_id, approve });
      toast(approve ? 'Approved' : 'Hidden');
      card.style.opacity = '0.35';
      setTimeout(() => renderMedia(m.album_id), 350);
    } catch (e) { toast(e.message); }
  };

  card.appendChild(el('div', { class: 'rowx' },
    el('button', { class: 'mini', onclick: () => decide(true) }, 'Approve'),
    el('button', { class: 'mini danger', onclick: () => decide(false) }, 'Hide')));
  return card;
}

/* ---------------- свежее: альбомы и файлы в любом статусе (059) ---------------- */
// Ленты «что появилось на сайте» независимо от модерации: автоодобренное,
// одобренное, ждущее, скрытое/отклонённое. Решение можно поменять в любой
// момент — те же действия mod-api (review, hide, ban) плюс media_set для файлов.
// Время — по Сайгону: модератор работает оттуда, а ленты сверяют с Telegram.
const SG_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Saigon', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const sgTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : `${SG_FMT.format(d)} ICT`; };
const STATUS_TONE = { auto: 'auto', approved: 'ok', pending: 'wait', rejected: 'bad', hidden: 'bad', draft: 'wait' };
const STATUS_TEXT = { auto: 'Auto-approved', approved: 'Approved', pending: 'Pending', rejected: 'Rejected', hidden: 'Hidden', draft: 'Draft' };
const statusChip = (s) => el('span', { class: `rs-chip rs-${STATUS_TONE[s] || 'wait'}`, text: STATUS_TEXT[s] || s });
const recentState = { albums: { status: 'all' }, media: { status: 'all' } };

function redeployNote(host, action) {
  clear(host).appendChild(el('div', { class: 'empty' },
    el('h3', { text: 'mod-api needs redeploying' }),
    el('div', { text: `This view uses the action “${action}” (migration 059 + the new mod-api). Deploy mod-api and reload.` })));
}

function filterBar(kind, options, onPick) {
  const bar = el('div', { class: 'rs-filters' }, el('span', { class: 'muted', text: 'Status:' }));
  options.forEach(([v, label]) => bar.appendChild(el('button', {
    class: 'chip btn-sm' + (recentState[kind].status === v ? ' on' : ''),
    onclick: () => { recentState[kind].status = v; onPick(); },
  }, label)));
  return bar;
}

async function banToggle(userId, handle, banned, after) {
  if (!userId) return;
  const reason = banned ? null : prompt(`Ban @${handle}? Reason (optional):`, '');
  if (!banned && reason === null) return;
  try {
    await call('ban', { user_id: userId, ban: !banned, reason: reason || null });
    toast(banned ? `@${handle} unbanned` : `@${handle} banned`);
    after(!banned);
  } catch (e) { toast(e.message); }
}

/* ---- альбомы ---- */
async function renderRecentAlbums() {
  clear(app);
  app.appendChild(head('Recent albums', 'ralbums'));
  app.appendChild(filterBar('albums', [['all', 'All'], ['auto', 'Auto-approved'], ['approved', 'Approved'],
    ['pending', 'Pending'], ['rejected', 'Rejected'], ['hidden', 'Hidden'], ['draft', 'Drafts']], renderRecentAlbums));
  const info = el('div', { class: 'muted', style: 'font-size:13px;margin:10px 0 12px', text: 'Loading…' });
  const list = el('div', { class: 'side-card', style: 'padding:6px 18px' });
  const more = el('div', { style: 'display:flex;justify-content:center;margin:16px 0' });
  app.append(info, list, more);
  const st = recentState.albums;
  let offset = 0;

  const page = async () => {
    let d;
    try { d = (await call('mod_recent_albums', { status: st.status, limit: 30, offset })).data || {}; }
    catch (e) { if (e.message === 'unknown_action') { clear(list); clear(more); return redeployNote(info, 'mod_recent_albums'); } info.textContent = e.message; return; }
    const rows = d.rows || [];
    const urls = await signPaths(rows.map(a => a.cover_path));
    rows.forEach(a => list.appendChild(albumRow(a, urls)));
    offset += rows.length;
    info.textContent = `${d.total ?? offset} album${d.total === 1 ? '' : 's'} · newest first · times in Asia/Saigon (ICT)`;
    if (!offset) list.appendChild(el('div', { class: 'muted', style: 'padding:14px 0', text: 'No albums with this status.' }));
    clear(more);
    if (offset < (d.total ?? 0)) more.appendChild(el('button', { class: 'btn btn-ghost btn-sm', onclick: (e) => { e.currentTarget.disabled = true; page(); } }, `Load more (${d.total - offset} left)`));
  };
  page();
}

function albumRow(a, urls) {
  const node = el('div', { class: 'rs-row' });
  const draw = () => {
    clear(node);
    const thumb = el('div', { class: 'rs-thumb' });
    if (urls[a.cover_path]) thumb.appendChild(el('img', { src: urls[a.cover_path], alt: '' }));
    const status = a.status === 'pending' && !a.published_at ? 'draft' : a.status;
    const decided = a.decided_by ? `${a.decided_action || 'decided'} by ${a.decided_by === 'system' ? 'system (auto)' : a.decided_by} · ${sgTime(a.decided_at)}` : 'no decision logged';
    node.append(
      thumb,
      el('div', { class: 'rs-main' },
        el('div', { class: 'rs-line' },
          statusChip(status),
          a.hidden_at && a.status !== 'hidden' ? statusChip('hidden') : null,
          a.is_event ? el('span', { class: 'prov', text: 'Event' }) : null,
          a.visibility && a.visibility !== 'public' ? el('span', { class: 'prov', text: VIS_LABEL[a.visibility] || a.visibility }) : null,
          a.reports ? el('span', { class: 'prov warn', text: `${a.reports} report${a.reports === 1 ? '' : 's'}` }) : null),
        el('a', { class: 'rs-title', href: albumHref(a.id), target: '_blank', rel: 'noopener', text: a.title || '(untitled)' }),
        el('div', { class: 'muted rs-sub' },
          'by ', a.author ? el('a', { href: profileHref(a.author), target: '_blank', rel: 'noopener', style: linkStyle, text: `@${a.author}` }) : '—',
          a.author_banned ? el('span', { class: 'rs-banned', text: ' BANNED' }) : null,
          ` · created ${sgTime(a.created_at)}`,
          a.published_at ? ` · published ${sgTime(a.published_at)}` : ' · not published',
          ` · ${a.files ?? 0} file${a.files === 1 ? '' : 's'}${a.held ? `, ${a.held} waiting` : ''}`),
        el('div', { class: 'muted rs-sub', text: decided + (a.review_note ? ` · note: ${a.review_note}` : '') })),
      el('div', { class: 'rs-acts' },
        el('button', { class: 'mini', disabled: a.status === 'approved' || a.status === 'auto' ? 'disabled' : null, onclick: () => review(true) }, 'Approve'),
        el('button', { class: 'mini danger', disabled: a.status === 'rejected' ? 'disabled' : null, onclick: () => review(false) }, 'Reject'),
        el('button', { class: 'mini' + (a.hidden_at ? '' : ' danger'), onclick: hide }, a.hidden_at ? 'Unhide' : 'Hide'),
        el('button', { class: 'mini' + (a.author_banned ? '' : ' danger'), onclick: () => banToggle(a.author_id, a.author, a.author_banned, (b) => { a.author_banned = b; draw(); }) },
          a.author_banned ? 'Unban author' : 'Ban author'),
        el('a', { class: 'mini', href: albumModHref(a.id), target: '_blank', rel: 'noopener' }, 'Moderate ↗'),
        a.author ? el('button', { class: 'mini', onclick: () => renderUserAlbums(a.author, renderRecentAlbums) }, 'Author’s albums') : null));
  };
  const review = async (approve) => {
    const note = approve ? null : prompt('Reason (sent to the author):', '');
    if (!approve && note === null) return;
    try {
      await call('review', { album_id: a.id, approve, note: note || null });
      Object.assign(a, { moderation_status: approve ? 'approved' : 'rejected', status: a.hidden_at ? 'hidden' : (approve ? 'approved' : 'rejected'),
        decided_by: 'you', decided_action: approve ? 'approve' : 'reject', decided_at: new Date().toISOString(), review_note: note || null });
      toast(approve ? 'Album approved' : 'Album rejected');
      draw();
    } catch (e) { toast(e.message); }
  };
  const hide = async () => {
    const hideIt = !a.hidden_at;
    const reason = hideIt ? prompt('Hide album. Reason (optional):', '') : null;
    if (hideIt && reason === null) return;
    try {
      await call('hide', { subject_type: 'album', subject_id: a.id, hide: hideIt, reason: reason || null });
      a.hidden_at = hideIt ? new Date().toISOString() : null;
      a.status = hideIt ? 'hidden' : (a.moderation_status === 'rejected' ? 'rejected' : a.moderation_status === 'pending' ? 'pending' : 'approved');
      Object.assign(a, { decided_by: 'you', decided_action: hideIt ? 'hide' : 'unhide', decided_at: new Date().toISOString() });
      toast(hideIt ? 'Album hidden' : 'Album visible again');
      draw();
    } catch (e) { toast(e.message); }
  };
  draw();
  return node;
}

/* ---- файлы ---- */
async function renderRecentMedia() {
  clear(app);
  app.appendChild(head('Recent media', 'rmedia'));
  app.appendChild(filterBar('media', [['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'],
    ['auto', 'Auto-approved'], ['hidden', 'Hidden']], renderRecentMedia));
  const info = el('div', { class: 'muted', style: 'font-size:13px;margin:10px 0 12px', text: 'Loading…' });
  const grid = el('div', { class: 'mq-grid' });
  const more = el('div', { style: 'display:flex;justify-content:center;margin:16px 0' });
  app.append(info, grid, more);
  const st = recentState.media;
  let offset = 0;

  const page = async () => {
    let d;
    try { d = (await call('mod_recent_media', { status: st.status, limit: 48, offset })).data || {}; }
    catch (e) { if (e.message === 'unknown_action') { clear(grid); clear(more); return redeployNote(info, 'mod_recent_media'); } info.textContent = e.message; return; }
    const rows = d.rows || [];
    const urls = await signPaths(rows.flatMap(m => [m.thumb, m.path]));
    rows.forEach(m => grid.appendChild(recentMediaCard(m, urls)));
    offset += rows.length;
    info.textContent = `${d.total ?? offset} file${d.total === 1 ? '' : 's'} · newest upload first · times in Asia/Saigon (ICT) · “Auto-approved” = uploaded before media moderation or an already-approved file`;
    if (!offset) grid.appendChild(el('div', { class: 'muted', text: 'No files with this status.' }));
    clear(more);
    if (offset < (d.total ?? 0)) more.appendChild(el('button', { class: 'btn btn-ghost btn-sm', onclick: (e) => { e.currentTarget.disabled = true; page(); } }, `Load more (${d.total - offset} left)`));
  };
  page();
}

function recentMediaCard(m, urls) {
  const card = el('div', { class: 'mq-card' });
  const draw = () => {
    clear(card);
    const stage = el('div', { style: 'position:relative;border-radius:12px;overflow:hidden;background:#EFEDE8;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;cursor:zoom-in' });
    const src = urls[m.thumb] || urls[m.path];
    if (src && m.kind === 'video') stage.appendChild(el('video', { src: (urls[m.path] || src) + '#t=0.1', muted: 'muted', playsinline: 'playsinline', controls: 'controls', style: 'width:100%;height:100%;object-fit:contain' }));
    else if (src && m.kind === 'audio') stage.appendChild(el('audio', { src: urls[m.path] || src, controls: 'controls', style: 'width:92%' }));
    else if (src) stage.appendChild(el('img', { src, alt: '', style: 'width:100%;height:100%;object-fit:cover' }));
    else stage.appendChild(el('div', { class: 'muted', text: 'no preview' }));
    if (m.kind === 'photo') stage.onclick = () => { const u = urls[m.path] || urls[m.thumb]; if (u) window.open(u, '_blank', 'noopener'); };
    stage.appendChild(el('span', { class: 'rs-onimg' }, statusChip(m.status)));
    const who = m.uploader_guest ? 'guest (no sign-in)' : `@${m.uploader || '?'}`;
    card.append(stage,
      el('div', {},
        el('a', { class: 'mq-card-album', href: albumHref(m.album_id), target: '_blank', rel: 'noopener', text: `📁 ${m.album_title || '(album)'}` }),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          'album by ', m.author ? el('a', { href: profileHref(m.author), target: '_blank', rel: 'noopener', style: 'color:inherit;text-decoration:underline', text: `@${m.author}` }) : '—',
          m.is_event ? ' · event' : '', m.album_published ? '' : ' · draft'),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          `uploaded by ${who}${m.uploader_is_author ? ' (author)' : ''}`,
          m.uploader_banned ? el('span', { class: 'rs-banned', text: ' BANNED' }) : null,
          ` · ${sgTime(m.created_at)}`),
        m.decided_by ? el('div', { class: 'muted', style: 'font-size:12px', text: `${m.status === 'hidden' ? 'hidden' : 'approved'} by ${m.decided_by} · ${sgTime(m.decided_at)}` }) : null,
        m.owner_private ? el('div', { class: 'muted', style: 'font-size:12px', text: 'owner keeps it private' }) : null,
        m.caption ? el('div', { style: 'font-size:13px;margin-top:3px', text: `“${m.caption}”` }) : null),
      el('div', { class: 'rowx' },
        el('button', { class: 'mini', disabled: m.status === 'approved' ? 'disabled' : null, onclick: () => decide(true) }, 'Approve'),
        el('button', { class: 'mini danger', disabled: m.status === 'hidden' ? 'disabled' : null, onclick: () => decide(false) }, 'Hide'),
        m.uploader_id ? el('button', { class: 'mini' + (m.uploader_banned ? '' : ' danger'), title: 'Ban the person who uploaded this file',
          onclick: () => banToggle(m.uploader_id, m.uploader || 'guest', m.uploader_banned, (b) => { m.uploader_banned = b; draw(); }) },
          m.uploader_banned ? 'Unban uploader' : 'Ban uploader') : null,
        el('a', { class: 'mini', href: albumModHref(m.album_id), target: '_blank', rel: 'noopener' }, 'Album ↗')));
  };
  const decide = async (approve) => {
    try {
      const r = (await call('media_set', { am_id: m.am_id, approve })).data || {};
      if (r.error) { toast(r.error); return; }
      Object.assign(m, { status: approve ? 'approved' : 'hidden', decided_by: 'you', decided_at: new Date().toISOString(), held: false });
      toast(approve ? 'Approved' : 'Hidden');
      draw();
    } catch (e) { toast(e.message === 'unknown_action' ? 'mod-api needs redeploying (media_set)' : e.message); }
  };
  draw();
  return card;
}

/* ---------------- альбом целиком, как его увидит зритель ---------------- */

/**
 * Решение принимается по полному альбому, а не по плитке превью: нужны подписи
 * под кадрами, видео со звуком и голосовые заметки. Вёрстка — общая с сайтом
 * (albumview.js), поэтому модератор видит ровно то, что увидят люди.
 */
async function openAlbum(albumId) {
  clear(app);
  app.appendChild(el('div', { class: 'muted', text: 'Loading album…' }));

  let d;
  try { d = (await call('open_album', { album_id: albumId })).data; }
  catch (e) { clear(app).appendChild(el('div', { class: 'muted', text: e.message })); return; }
  // Ссылка из уведомления живёт дольше самого альбома: автор может удалить его
  // через минуту после публикации. Тупик с «not found» тут читается как поломка
  // панели, поэтому объясняем, что произошло, и возвращаем в очередь.
  if (!d) {
    clear(app);
    app.appendChild(el('div', { class: 'empty' },
      el('h3', { text: 'Album is gone' }),
      el('div', { text: 'The author deleted it after publishing — the media stays in their own library.' })));
    app.appendChild(el('div', { style: 'display:flex;justify-content:center;margin-top:16px' },
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => renderMedia() }, '← Back to queue')));
    return;
  }

  const a = d.album, author = d.author || {};
  const all = [...(d.chapters || []).flatMap(c => c.media || []), ...(d.loose || [])];
  const paths = [a.cover_path, ...all.flatMap(m => [m.path, m.thumb, m.voice_path]),
    d.narration?.path, ...(d.galleries || []).map(g => g.voice_path)];
  const urls = await signPaths(paths);

  clear(app);
  app.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;flex-wrap:wrap' },
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => renderMedia(albumId) }, '← Back to queue'),
    el('div', { class: 'rowx' },
      el('span', { class: 'muted', style: 'font-size:13.5px', text: `status: ${a.moderation_status}` }),
      el('button', { class: 'mini', onclick: () => reviewFromViewer(albumId, true) }, 'Approve'),
      el('button', { class: 'mini danger', onclick: () => reviewFromViewer(albumId, false) }, 'Reject'))));

  /* ---- шапка альбома: как на странице альбома ---- */
  const hero = el('div', { class: 'album-hero' });
  if (urls[a.cover_path]) hero.appendChild(el('img', { src: urls[a.cover_path], alt: a.title }));
  hero.appendChild(el('div', { class: 'hero-card' },
    el('div', { class: 'hero-inner' },
      a.category ? el('div', { class: 'kicker', text: String(a.category).toUpperCase() }) : null,
      el('div', { class: 'hero-title', text: a.title }),
      el('div', { class: 'hero-sub', text: `${author.name || author.username} · ${a.published_at ? timeAgo(a.published_at) : 'draft'}` }),
      el('div', { class: 'pill', text: composition(a) }))));
  app.appendChild(hero);

  const left = el('div', { style: 'max-width:800px' });
  const right = el('aside', {});
  app.appendChild(el('div', { class: 'album-cols' }, left, right));

  if (a.description) left.appendChild(el('p', { class: 'lede', text: a.description }));

  // Дорожка-рассказ: её тоже нужно прослушать.
  if (d.narration?.path) {
    left.appendChild(el('div', { class: 'kicker kicker-muted', style: 'margin-top:22px', text: 'NARRATION' }));
    left.appendChild(audioRow({ id: d.narration.id, path: d.narration.path, duration: d.narration.duration, caption: 'Narration track' }, urls, VIEW));
  }

  const body = el('div', { style: 'margin-top:24px' });
  left.appendChild(body);
  if (all.length || (d.texts || []).length) renderStory(body, d, urls, VIEW);
  else left.appendChild(el('p', { class: 'muted', text: 'No media in this album.' }));

  /* ---- боковая справка о находке ---- */
  const side = el('div', { class: 'sticky' },
    el('div', { class: 'side-card' },
      el('div', { style: 'display:flex;gap:12px;align-items:center' },
        avatarImg(author.avatar, author.name, 48),
        el('div', {},
          el('div', { style: 'font-size:16px;font-weight:700', text: author.name || author.username }),
          el('div', { class: 'card-sub', text: '@' + author.username }))),
      el('div', { style: 'margin-top:14px;border-top:1px solid var(--line);padding-top:12px' },
        row('Visibility', a.visibility),
        row('Albums by author', author.albums_total),
        row('Author banned', author.banned ? 'YES' : 'no'),
        row('Private files', all.filter(m => m.is_private).length),
        row('Collaborators', (d.collaborators || []).length),
        row('Comments', (d.comments || []).length))));
  right.appendChild(side);

  if ((d.comments || []).length) {
    const cbox = el('div', { class: 'side-card', style: 'margin-top:16px' },
      el('div', { style: 'font-weight:700;margin-bottom:8px', text: 'Comments' }));
    d.comments.forEach(c => cbox.appendChild(el('div', { style: 'font-size:14px;padding:6px 0;border-bottom:1px solid #F5F3EF' },
      el('b', { text: '@' + c.author + ' ' }),
      el('span', { text: c.body }),
      c.hidden ? el('span', { class: 'muted', text: ' (hidden)' }) : null)));
    right.appendChild(cbox);
  }
}

function row(k, v) {
  return el('div', { style: 'display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:14.5px' },
    el('span', { class: 'muted', text: k }), el('b', { text: String(v) }));
}

async function reviewFromViewer(albumId, approve) {
  const note = approve ? null : (prompt('Reason (sent to the author):') || null);
  try {
    await call('review', { album_id: albumId, approve, note });
    toast(approve ? 'Approved' : 'Rejected');
    renderMedia();
  } catch (e) { toast(e.message); }
}

/** Подписанные ссылки на медиа — их выдаёт та же функция под сервисным ключом. */
async function signPaths(paths) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return {};
  const out = {};
  try {
    const signed = (await call('sign', { paths: list })).data || [];
    signed.forEach(s => { if (s.signedUrl) out[s.path] = s.signedUrl; });
  } catch (_) { /* без ссылок покажем хотя бы текст */ }
  return out;
}

// Ссылка живёт 10 минут: если модератор засмотрелся, переподписываем по ошибке.
const VIEW = {
  onImageClick: (items, i, urls) => {
    const u = urls[items[i].path] || urls[items[i].thumb];
    if (u) window.open(u, '_blank', 'noopener');
  },
  refresh: (node, path) => {
    let retried = false;
    node.addEventListener('error', async () => {
      if (retried) return;
      retried = true;
      const urls = await signPaths([path]);
      if (urls[path]) { node.src = urls[path]; node.load?.(); retried = false; }
    });
  },
  mark: (m) => (m.is_private
    ? el('div', { class: 'muted', style: 'font-size:13px;margin-top:2px', text: 'private file — visible only to the author and collaborators' })
    : null),
};

/* ---------------- пользователи ---------------- */

// Фильтры переживают перерисовку списка: «загрузить ещё» и смена страны не
// должны сбрасывать друг друга.
const usersFilter = { plan: null, country: null, q: null, limit: 50, offset: 0 };

const PLAN_LABEL = { free: 'Free', pro: 'Pro' };

/** Дата без времени: в списке важен день, а не минута. */
function day(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

/** Флаг страны эмодзи из кода ISO: две буквы → два региональных символа. */
function flag(code) {
  if (!code || code === '??' || code.length !== 2) return '🌍';
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

async function renderUsers() {
  clear(app);
  app.appendChild(head('Users', 'users'));

  const filters = el('div', { style: 'margin-bottom:16px' });
  const body = el('div', {}, el('div', { class: 'muted', text: 'Loading…' }));
  app.append(filters, body);

  let d;
  try { d = (await call('users', usersFilter)).data; }
  catch (e) { clear(body).appendChild(el('div', { class: 'muted', text: e.message })); return; }
  if (!d) { clear(body).appendChild(el('div', { class: 'muted', text: 'No data' })); return; }

  drawUsersFilters(filters, d);
  drawUsersList(body, d);
}

/** Смена фильтра всегда начинает список заново — иначе смещение врёт. */
function applyUsersFilter(patch) {
  Object.assign(usersFilter, patch, { offset: 0 });
  renderUsers();
}

function drawUsersFilters(host, d) {
  clear(host);
  const plans = d.plans || {};

  const planRow = el('div', { class: 'rowx', style: 'margin-bottom:10px' },
    el('span', { class: 'muted', style: 'font-size:13px;min-width:64px', text: 'Plan' }));
  [[null, `All (${(plans.free || 0) + (plans.pro || 0)})`],
   ['free', `Free (${plans.free || 0})`],
   ['pro', `Pro (${plans.pro || 0})`],
   ['events', `Events (${plans.events || 0})`]].forEach(([value, label]) => {
    planRow.appendChild(el('button', {
      class: 'chip btn-sm' + (usersFilter.plan === value ? ' on' : ''),
      onclick: () => applyUsersFilter({ plan: value }),
    }, label));
  });

  const countryRow = el('div', { class: 'rowx', style: 'margin-bottom:10px' },
    el('span', { class: 'muted', style: 'font-size:13px;min-width:64px', text: 'Country' }));
  countryRow.appendChild(el('button', {
    class: 'chip btn-sm' + (usersFilter.country === null ? ' on' : ''),
    onclick: () => applyUsersFilter({ country: null }),
  }, 'All'));
  (d.countries || []).forEach(c => countryRow.appendChild(el('button', {
    class: 'chip btn-sm' + (usersFilter.country === c.code ? ' on' : ''),
    onclick: () => applyUsersFilter({ country: c.code }),
  }, `${flag(c.code)} ${c.code === '??' ? 'Unknown' : c.code} (${c.n})`)));

  const search = el('input', {
    class: 'input', style: 'max-width:280px;height:40px;padding:0 14px',
    placeholder: 'name or email', autocomplete: 'off', value: usersFilter.q || '',
  });
  search.onkeydown = (e) => {
    if (e.key === 'Enter') applyUsersFilter({ q: search.value.trim() || null });
  };
  const searchRow = el('div', { class: 'rowx' },
    el('span', { class: 'muted', style: 'font-size:13px;min-width:64px', text: 'Search' }),
    search,
    el('button', { class: 'mini', onclick: () => applyUsersFilter({ q: search.value.trim() || null }) }, 'Find'));
  if (usersFilter.q) {
    searchRow.appendChild(el('button', { class: 'mini', onclick: () => applyUsersFilter({ q: null }) }, 'Reset'));
  }

  host.append(planRow, countryRow, searchRow);
}

function drawUsersList(host, d) {
  clear(host);
  const rows = d.rows || [];
  const total = d.total || 0;

  host.appendChild(el('div', { class: 'muted', style: 'font-size:13.5px;margin-bottom:10px',
    text: `${total} ${total === 1 ? 'person' : 'people'}`
        + (d.guests ? ` · ${d.guests} guest ${d.guests === 1 ? 'session' : 'sessions'} without sign-in (not listed)` : '') }));

  if (!rows.length) {
    host.appendChild(el('div', { class: 'muted', text: 'Nobody matches these filters.' }));
    return;
  }

  const COLS = '1.4fr 1.8fr .7fr .9fr .9fr .5fr 1.5fr';
  const line = (cells, head) => el('div', {
    class: head ? 'muted' : '',
    style: `display:grid;grid-template-columns:${COLS};gap:10px;padding:9px 0;font-size:14px;align-items:baseline;`
      + (head ? 'border-bottom:1px solid #EFEDE8;font-size:12.5px' : 'border-bottom:1px solid #F5F3EF'),
  }, ...cells.map(c => (typeof c === 'string' ? el('span', { text: c }) : c)));

  const box = el('div', { style: 'overflow-x:auto' });
  const table = el('div', { style: 'min-width:940px' },
    line(['User', 'Email', 'Plan', 'Plan since', 'Plan until', 'Country', 'Event albums (created · unused)'], true));

  rows.forEach(u => {
    const name = el('span', {},
      el('a', {
        href: 'profile.html?u=' + encodeURIComponent(u.username),
        target: '_blank',
        rel: 'noopener noreferrer',
        style: 'color:inherit;font-weight:700;text-decoration:underline',
        text: '@' + u.username,
      }),
      u.display_name ? el('span', { class: 'muted', style: 'font-size:12.5px;display:block', text: u.display_name }) : null,
      u.banned_at ? el('span', { style: 'font-size:12px;color:#B3452F;display:block', text: 'banned' }) : null,
      u.deleted_at ? el('span', { class: 'muted', style: 'font-size:12px;display:block', text: 'deleted' }) : null);

    const plan = el('span', {
      style: 'font-weight:700;font-size:13px;padding:2px 9px;border-radius:999px;'
        + (u.plan === 'pro' ? 'background:rgba(201,162,39,.12);color:#C9A227' : 'background:#EFEDE8;color:#7A7265'),
      text: PLAN_LABEL[u.plan] || u.plan,
    });

    const events = eventTiersCell(u);

    table.appendChild(line([
      name,
      el('span', { style: 'font-size:13px;word-break:break-all', text: u.email || '—' }),
      plan,
      day(u.plan_since),
      day(u.plan_until),
      el('span', { title: u.country || 'unknown', text: `${flag(u.country)} ${u.country || '—'}` }),
      events,
    ]));
  });

  box.appendChild(table);
  host.appendChild(box);

  if (rows.length < total) {
    const more = el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-top:14px' },
      `Load more (${total - rows.length} left)`);
    more.onclick = async () => {
      more.disabled = true;
      usersFilter.offset += usersFilter.limit;
      let next;
      try { next = (await call('users', usersFilter)).data; }
      catch (e) { toast(e.message); more.disabled = false; usersFilter.offset -= usersFilter.limit; return; }
      // Дорисовываем к уже показанному: перерисовка с нуля увела бы
      // прокрутку в начало на каждой подгрузке.
      drawUsersList(host, { ...next, rows: [...rows, ...(next.rows || [])] });
    };
    host.appendChild(more);
  }
}

/* ---------------- событийные альбомы по тарифам ---------------- */

const TIER_KEYS = ['small', 'medium', 'large'];
const TIER_LABEL = { small: 'Small', medium: 'Medium', large: 'Large' };
const TIER_CAP = { small: '100 GB · ~100 guests', medium: '200 GB · ~250 guests', large: '400 GB · ~500 guests' };
const TIER_COLOR = { small: '#7A7265', medium: '#A8871E', large: '#8A4B2F' };

/**
 * Разбивка пользователя по тарифам: {small:{albums,unused}, …}. Без миграции
 * 054 полей ev_* нет — тогда всё считаем Small (до тарифов альбом стоил $39.99).
 */
function userTiers(u) {
  const out = {};
  TIER_KEYS.forEach(k => {
    out[k] = u.ev_albums || u.ev_unused
      ? { albums: Number(u.ev_albums?.[k]) || 0, unused: Number(u.ev_unused?.[k]) || 0 }
      : { albums: k === 'small' ? Number(u.event_albums) || 0 : 0, unused: k === 'small' ? Number(u.event_left) || 0 : 0 };
  });
  return out;
}

function tierChip(k, text) {
  return el('span', {
    title: TIER_CAP[k],
    style: `display:inline-flex;gap:6px;align-items:baseline;font-size:12.5px;padding:2px 8px;border-radius:999px;`
      + `border:1px solid #E4DCCE;white-space:nowrap`,
  },
  el('b', { style: `color:${TIER_COLOR[k]};font-size:11.5px;letter-spacing:.04em;text-transform:uppercase`, text: TIER_LABEL[k] }),
  el('span', { text }));
}

/** Ячейка «Event albums»: по чипу на тариф, где что-то есть: «2 · +1». */
function eventTiersCell(u) {
  const t = userTiers(u);
  const chips = TIER_KEYS.filter(k => t[k].albums || t[k].unused)
    .map(k => tierChip(k, `${t[k].albums} · ${t[k].unused ? '+' + t[k].unused : '0'}`));
  if (!chips.length) return el('span', { class: 'muted', text: '—' });
  return el('span', { style: 'display:flex;flex-wrap:wrap;gap:4px' }, ...chips);
}

/** Сводка по тарифам для «Статистики» (блок events из admin_stats, 054). */
function eventTiersPanel(ev) {
  if (!ev) {
    return panel('Event albums by tier', el('div', { class: 'muted', style: 'font-size:13.5px',
      text: 'Per-tier totals appear after migration 054 is applied. Until then all event credits count as Small (see Users → Events).' }));
  }
  const line = (cells, head) => el('div', {
    class: head ? 'muted' : '',
    style: 'display:grid;grid-template-columns:1.6fr repeat(4,1fr);gap:8px;padding:7px 0;font-size:14px;align-items:baseline'
      + (head ? ';border-bottom:1px solid #EFEDE8;font-size:12.5px' : ';border-bottom:1px solid #F5F3EF'),
  }, ...cells.map(x => (typeof x === 'string' || typeof x === 'number' ? el('span', { text: String(x) }) : x)));
  const box = el('div', { style: 'overflow-x:auto' });
  const table = el('div', { style: 'min-width:330px' }, line(['Tier', 'Paid', 'Granted', 'Created', 'Unused'], true));
  const sum = { paid: 0, granted: 0, albums: 0, unused: 0 };
  TIER_KEYS.forEach(k => {
    const row = {
      paid: Number(ev.paid?.[k]) || 0, granted: Number(ev.granted?.[k]) || 0,
      albums: Number(ev.albums?.[k]) || 0, unused: Number(ev.unused?.[k]) || 0,
    };
    Object.keys(sum).forEach(x => { sum[x] += row[x]; });
    table.appendChild(line([
      el('span', {}, el('b', { style: `color:${TIER_COLOR[k]}`, text: TIER_LABEL[k] }),
        el('span', { class: 'muted', style: 'font-size:12px;display:block', text: TIER_CAP[k] })),
      row.paid, row.granted, row.albums, row.unused]));
  });
  table.appendChild(line([el('b', { text: 'Total' }), el('b', { text: String(sum.paid) }), el('b', { text: String(sum.granted) }),
    el('b', { text: String(sum.albums) }), el('b', { text: String(sum.unused) })]));
  box.appendChild(table);
  return panel('Event albums by tier', el('div', {}, box,
    el('div', { class: 'muted', style: 'font-size:12.5px;margin-top:8px',
      text: `Paid = purchases (PayPal/Paddle), list price total $${(Number(ev.paid?.usd) || 0).toFixed(2)}. `
        + 'Granted = given manually with a tier. Credits and albums from before tiers ($39.99) count as Small.' })));
}

/* ---------------- продуктовая статистика ---------------- */
let statDays = 30;

async function renderStats() {
  clear(app);
  app.appendChild(head('Statistics', 'stats'));

  const bar = el('div', { class: 'rowx', style: 'margin-bottom:18px' });
  [7, 30, 90].forEach(n => bar.appendChild(el('button', {
    class: 'chip' + (statDays === n ? ' on' : ''),
    onclick: () => { statDays = n; statPick = null; renderStats(); },
  }, `${n} days`)));
  app.appendChild(bar);

  const body = el('div', {}, el('div', { class: 'muted', text: 'Loading…' }));
  app.appendChild(body);

  let d;
  try { d = (await call('stats', { days: statDays })).data; }
  catch (e) { clear(body).appendChild(el('div', { class: 'muted', text: e.message })); return; }
  if (!d) { clear(body).appendChild(el('div', { class: 'muted', text: 'No data' })); return; }

  clear(body);
  const u = d.users || {}, c = d.content || {}, a = d.activity || {};
  body.appendChild(tiles([
    ['Users', u.total, `+${u.new || 0} in period`],
    ['Pro', u.pro, `${u.banned || 0} banned`],
    ['Albums', c.albums, `${c.published || 0} published, +${c.new_albums || 0}`],
    ['Media', c.media, `${gb(c.bytes)} · ${c.media_r2 || 0} in R2`],
    ['Visits', a.views, `${a.impressions || 0} impressions`],
    ['Time on album', secs(a.avg_dwell_ms), 'average'],
    ['Button clicks', a.clicks, 'Pro profiles'],
    ['Open reports', a.reports_open, 'awaiting review'],
    ...(d.events ? [['Event albums', TIER_KEYS.reduce((n, k) => n + (Number(d.events.albums?.[k]) || 0), 0),
      TIER_KEYS.map(k => `${TIER_LABEL[k][0]} ${Number(d.events.albums?.[k]) || 0}`).join(' · ') + ' created']] : []),
  ]));

  body.appendChild(eventTiersPanel(d.events));
  body.appendChild(statsByDay(d.by_day || []));
  body.appendChild(panel('Countries', barList((d.geo || []).map(g => [g.code || '??', g.n]))));
  body.appendChild(panel('Top albums', topList(d.top_albums || [])));
  body.appendChild(planForm());
  body.appendChild(eventForm(!!d.events));
}

function tiles(items) {
  const wrap = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px' });
  items.forEach(([label, value, hint]) => wrap.appendChild(
    el('div', { class: 'side-card', style: 'padding:16px' },
      el('div', { class: 'muted', style: 'font-size:13px', text: label }),
      el('div', { style: 'font-size:24px;font-weight:800;margin-top:2px', text: String(value ?? 0) }),
      el('div', { class: 'muted', style: 'font-size:12px', text: hint || '' }))));
  return wrap;
}

function panel(title, node) {
  return el('div', { class: 'side-card', style: 'margin-top:18px' },
    el('div', { style: 'font-size:17px;font-weight:700;margin-bottom:10px', text: title }), node);
}

function dayTable(rows) {
  const live = rows;
  if (!live.length) return el('div', { class: 'muted', text: 'Nothing happened in this period.' });
  const line = (cells, muted) => el('div', {
    class: muted ? 'muted' : '',
    style: 'display:grid;grid-template-columns:1.4fr repeat(4,1fr);gap:8px;padding:6px 0;font-size:14px'
      + (muted ? ';border-bottom:1px solid #EFEDE8;font-size:12.5px' : ';border-bottom:1px solid #F5F3EF'),
  }, ...cells.map(x => el('span', { text: String(x) })));
  const box = el('div', {}, line(['Day', 'Visits', 'Active', 'Signups', 'Albums'], true));
  live.forEach(r => {
    const n = line([r.day, r.views, r.actives, r.signups, r.albums]);
    if (!(r.views || r.actives || r.signups || r.albums)) n.style.color = '#B5AC9E';
    box.appendChild(n);
  });
  return box;
}

function barList(rows) {
  const clean = rows.filter(r => r[1] > 0);
  if (!clean.length) return el('div', { class: 'muted', text: 'No data yet.' });
  const max = Math.max(...clean.map(r => r[1]));
  const box = el('div', { class: 'stack', style: 'gap:8px' });
  clean.forEach(([label, n]) => box.appendChild(el('div', {},
    el('div', { style: 'display:flex;justify-content:space-between;font-size:14px' },
      el('span', { text: label }), el('span', { class: 'muted', text: String(n) })),
    el('div', { style: 'height:7px;border-radius:99px;background:#EFEDE8;margin-top:3px' },
      el('i', { style: `display:block;height:100%;border-radius:99px;background:#C9A227;width:${Math.max(3, (n / max) * 100)}%` })))));
  return box;
}

function topList(rows) {
  if (!rows.length) return el('div', { class: 'muted', text: 'No visits yet.' });
  const box = el('div', { class: 'stack', style: 'gap:6px' });
  rows.forEach(r => box.appendChild(el('div', { style: 'display:flex;justify-content:space-between;gap:12px;font-size:14.5px' },
    el('span', { text: `${r.title || '—'} · @${r.author}` }),
    el('b', { text: String(r.views) }))));
  return box;
}

/** Выдача тарифа вручную: оплата пока принимается не автоматически. */
function planForm() {
  const user = el('input', { class: 'input', placeholder: 'username', autocomplete: 'off' });
  const plan = el('select', { class: 'select' },
    el('option', { value: 'pro' }, 'pro'), el('option', { value: 'free' }, 'free'));
  const days = el('input', { class: 'input', type: 'number', value: '30', min: '1', max: '3650' });
  const out = el('div', { class: 'muted', style: 'font-size:13.5px;min-height:20px' });
  const go = el('button', { class: 'btn btn-primary btn-sm' }, 'Apply');
  go.onclick = async () => {
    go.disabled = true;
    try {
      const r = await call('set_plan', {
        username: user.value.trim(), plan: plan.value, plan_days: parseInt(days.value, 10) || 30,
      });
      out.textContent = r.data?.error ? 'User not found' : `${r.data.username}: ${r.data.plan}`;
      toast('Done');
    } catch (e) { out.textContent = e.message; }
    go.disabled = false;
  };
  return panel('Plan', el('div', { class: 'stack' },
    el('div', { class: 'muted', style: 'font-size:13.5px', text: 'Payments are manual for now — grant Pro here after a PayPal payment.' }),
    user, plan, days, go, out));
}

/**
 * Выдача общих альбомов события — та же ручная схема, что и Pro, но считается
 * штуками: одна оплата Event Album = одна единица квоты. Отрицательное число
 * забирает обратно (например, при возврате платежа).
 */
function eventForm(tiersLive) {
  const user = el('input', { class: 'input', placeholder: 'username', autocomplete: 'off' });
  const count = el('input', { class: 'input', type: 'number', value: '1', min: '-20', max: '20' });
  const tier = el('select', { class: 'select' },
    ...TIER_KEYS.map(k => el('option', { value: k, disabled: k !== 'small' && !tiersLive ? 'disabled' : null },
      `${TIER_LABEL[k]} — ${TIER_CAP[k]}` + (k !== 'small' && !tiersLive ? ' (needs migration 054)' : ''))));
  const out = el('div', { class: 'muted', style: 'font-size:13.5px;min-height:20px' });
  const go = el('button', { class: 'btn btn-primary btn-sm' }, 'Grant');
  go.onclick = async () => {
    go.disabled = true;
    try {
      // Small уходит прежним вызовом без тарифа (кредит без тарифа = Small),
      // Medium/Large — с tier: это понимает только база с миграцией 054.
      const r = await call('grant_event', {
        username: user.value.trim(), count: parseInt(count.value, 10) || 0,
        ...(tier.value !== 'small' ? { tier: tier.value } : {}),
      });
      const tt = r.data?.tiers;
      const want = tier.value;
      out.textContent = !r.data ? 'No answer from the database (migration 054 applied?)'
        : r.data.error === 'not_found' ? 'User not found'
        : r.data?.error ? r.data.error
        : `${r.data.username}: ${r.data.credits} left`
          + (tt ? ` (${TIER_KEYS.map(k => `${TIER_LABEL[k]} ${tt[k] || 0}`).join(', ')})` : '')
          + ` · ${r.data.events} created`
          // старая mod-api не передаёт tier — база выдала Small
          + (r.data.username && r.data.tier && r.data.tier !== want ? ` — WARNING: granted as ${r.data.tier}; redeploy mod-api` : '');
      toast('Done');
    } catch (e) { out.textContent = e.message; }
    go.disabled = false;
  };
  return panel('Event albums', el('div', { class: 'stack' },
    el('div', { class: 'muted', style: 'font-size:13.5px',
      text: 'One paid Event Album = one credit of its tier. The user then sees "Shared album" in their profile, picks which credit to use, creates it and gets a permanent QR for guests. Negative number takes credits of that tier back. Medium/Large need migration 054 and the updated mod-api.' }),
    user, tier, count, go, out));
}

/* ---------------- графики «по дням» + списки регистраций и загрузок ---------------- */

// Дни считаются в UTC — так же, как admin_stats (current_date базы в UTC).
const DAY_MS = 86400000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
let statPick = null;        // выбранный кликом день 'YYYY-MM-DD' или null (весь период)

/** Ровно N дней до сегодняшнего (UTC) включительно; пустые дни — нулями. */
function fillDays(rows, n) {
  const by = new Map(rows.map(r => [String(r.day).slice(0, 10), r]));
  const today = Date.parse(isoDay(Date.now()));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = isoDay(today - i * DAY_MS);
    const r = by.get(day) || {};
    out.push({ day, views: +r.views || 0, actives: +r.actives || 0, signups: +r.signups || 0, albums: +r.albums || 0 });
  }
  return out;
}

/** Окно для списков: выбранный день или весь период. to — не включительно. */
function statWindow() {
  if (statPick) return { from: `${statPick}T00:00:00Z`, to: new Date(Date.parse(statPick) + DAY_MS).toISOString() };
  const today = Date.parse(isoDay(Date.now()));
  return { from: new Date(today - (statDays - 1) * DAY_MS).toISOString(), to: new Date(today + DAY_MS).toISOString() };
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, v);
  kids.flat().forEach(k => k && n.appendChild(k));
  return n;
}

const fmtDay = (day, long) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US',
  long ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** «Красивый» верх оси: 1, 2, 5 × 10^k. */
function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * Один график на SVG: kind 'area' (линии с заливкой) или 'bars' (группы столбиков).
 * series: [{key, label, color}]. onPick(day) — клик по дню.
 */
function dayChart(days, series, kind, onPick) {
  // на телефоне рисуем в узкой системе координат, чтобы подписи не мельчали
  const narrow = window.innerWidth < 720;
  const W = narrow ? 400 : 720, H = narrow ? 250 : 230, L = 34, R = 10, T = 14, B = 28;
  const iw = W - L - R, ih = H - T - B, n = days.length;
  const max = niceMax(Math.max(1, ...days.flatMap(d => series.map(s => d[s.key]))));
  const step = iw / n;
  const x = (i) => (kind === 'bars' ? L + step * (i + 0.5) : L + (n === 1 ? iw / 2 : (iw * i) / (n - 1)));
  const y = (v) => T + ih - (v / max) * ih;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', style: 'display:block;overflow:visible' });
  const defs = svg('defs');
  series.forEach((s, k) => defs.appendChild(svg('linearGradient', { id: `g-${kind}-${k}`, x1: 0, y1: 0, x2: 0, y2: 1 },
    svg('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': kind === 'area' ? 0.32 : 1 }),
    svg('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': kind === 'area' ? 0.02 : 0.75 }))));
  root.appendChild(defs);

  // сетка и подписи оси Y
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    root.appendChild(svg('line', { x1: L, x2: W - R, y1: yy, y2: yy, stroke: i ? '#F0ECE4' : '#E4DCCE', 'stroke-width': 1 }));
    const t = svg('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#9A9184' });
    t.textContent = Number.isInteger(v) ? String(v) : v.toFixed(1);
    root.appendChild(t);
  }
  // подписи оси X: не больше ~8, последний день всегда
  const every = Math.max(1, Math.ceil(n / (narrow ? 5 : 8)));
  days.forEach((d, i) => {
    if ((n - 1 - i) % every) return;
    const t = svg('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: '#9A9184' });
    t.textContent = fmtDay(d.day);
    root.appendChild(t);
  });

  const picked = statPick ? days.findIndex(d => d.day === statPick) : -1;
  if (picked >= 0) {
    root.appendChild(svg('rect', { x: kind === 'bars' ? L + step * picked : x(picked) - step / 2, y: T, width: step, height: ih,
      fill: '#C9A227', 'fill-opacity': 0.14, rx: 4 }));
  }

  if (kind === 'area') {
    series.forEach((s, k) => {
      const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(d[s.key]).toFixed(1)}`);
      if (s.fill !== false) {
        root.appendChild(svg('path', { d: `M${x(0)},${y(0)} L${pts.join(' L')} L${x(n - 1)},${y(0)} Z`, fill: `url(#g-area-${k})` }));
      }
      root.appendChild(svg('polyline', { points: pts.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2.4,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': s.dash || null }));
      if (n <= (narrow ? 14 : 31)) days.forEach((d, i) => root.appendChild(svg('circle', { cx: x(i), cy: y(d[s.key]), r: 2.6, fill: '#fff', stroke: s.color, 'stroke-width': 1.6 })));
    });
  } else {
    const gw = Math.min(step * 0.78, 34), bw = gw / series.length;
    days.forEach((d, i) => series.forEach((s, k) => {
      const v = d[s.key]; if (!v) return;
      const h = Math.max(2, (v / max) * ih);
      root.appendChild(svg('rect', { x: x(i) - gw / 2 + bw * k + 0.5, y: T + ih - h, width: Math.max(1.5, bw - 1), height: h,
        rx: Math.min(3, bw / 3), fill: `url(#g-bars-${k})` }));
    }));
  }

  // наведение: вертикальная направляющая + подсказка; клик — фильтр по дню
  const guide = svg('line', { y1: T, y2: T + ih, stroke: '#C9A227', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
  root.appendChild(guide);
  const wrap = el('div', { style: 'position:relative' });
  const tip = el('div', { style: 'position:absolute;top:0;left:0;pointer-events:none;opacity:0;transition:opacity .12s;'
    + 'background:#FFFDF8;border:1px solid #E4DCCE;border-radius:10px;box-shadow:0 6px 18px rgba(60,45,20,.12);'
    + 'padding:8px 10px;font-size:12.5px;min-width:130px;z-index:5' });
  days.forEach((d, i) => {
    const hit = svg('rect', { x: kind === 'bars' ? L + step * i : x(i) - step / 2, y: T, width: step, height: ih,
      fill: 'transparent', style: 'cursor:pointer' });
    hit.addEventListener('mouseenter', () => {
      guide.setAttribute('x1', x(i)); guide.setAttribute('x2', x(i)); guide.setAttribute('visibility', 'visible');
      clear(tip).append(
        el('div', { style: 'font-weight:700;margin-bottom:4px', text: fmtDay(d.day, true) }),
        ...series.map(s => el('div', { style: 'display:flex;align-items:center;gap:6px;justify-content:space-between' },
          el('span', { style: 'display:flex;align-items:center;gap:6px' },
            el('i', { style: `width:9px;height:9px;border-radius:3px;background:${s.color};display:inline-block` }), s.label),
          el('b', { text: String(d[s.key]) }))),
        el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px', text: statPick === d.day ? 'Click to show the whole period' : 'Click to filter lists below' }));
      const box = wrap.getBoundingClientRect(), px = (x(i) / W) * box.width;
      tip.style.opacity = '1';
      const tw = tip.offsetWidth;
      // сбоку от направляющей, внутри области графика: не закрывает заголовок
      tip.style.left = `${px + 12 + tw <= box.width ? px + 12 : Math.max(0, px - 12 - tw)}px`;
      tip.style.top = `${(T / H) * box.height}px`;
    });
    hit.addEventListener('mouseleave', () => { tip.style.opacity = '0'; guide.setAttribute('visibility', 'hidden'); });
    hit.addEventListener('click', () => onPick(d.day));
    root.appendChild(hit);
  });
  wrap.append(root, tip);
  return wrap;
}

function chartPanel(title, days, series, kind, onPick) {
  const legend = el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap;font-size:13px' },
    ...series.map(s => el('span', { style: 'display:flex;align-items:center;gap:6px' },
      el('i', { style: `width:12px;height:${kind === 'bars' ? 12 : 3}px;border-radius:3px;background:${s.color};display:inline-block` }),
      el('span', { class: 'muted', text: s.label }),
      el('b', { text: String(days.reduce((n, d) => n + d[s.key], 0)) }))));
  return el('div', { class: 'side-card', style: 'margin-top:18px;min-width:0' },
    el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px' },
      el('div', { style: 'font-size:17px;font-weight:700', text: title }), legend),
    dayChart(days, series, kind, onPick));
}

/** Блок «по дням»: два графика, таблица под спойлером, оба списка. */
function statsByDay(rows) {
  const host = el('div', {});
  const days = fillDays(rows, statDays);
  const draw = () => {
    clear(host);
    const pick = (day) => { statPick = statPick === day ? null : day; draw(); };
    host.appendChild(el('div', { class: 'stat-charts' },
      chartPanel('Visits & active users', days, [
        { key: 'views', label: 'Visits', color: '#C9A227' },
        { key: 'actives', label: 'Active', color: '#8A4B2F', fill: false },
      ], 'area', pick),
      chartPanel('Signups & new albums', days, [
        { key: 'signups', label: 'Signups', color: '#C9A227' },
        { key: 'albums', label: 'Albums', color: '#8A4B2F' },
      ], 'bars', pick)));

    const table = el('details', { class: 'side-card', style: 'margin-top:18px' },
      el('summary', { style: 'cursor:pointer;font-size:15px;font-weight:700', text: `By day — table (${days.length} days, UTC)` }),
      el('div', { style: 'margin-top:10px' }, dayTable([...days].reverse())));
    host.appendChild(table);

    const w = statWindow();
    host.appendChild(el('div', { class: 'stat-filter' },
      el('span', { class: 'muted', text: 'Lists below: ' }),
      el('b', { text: statPick ? `${fmtDay(statPick, true)} (UTC day)` : `last ${statDays} days` }),
      statPick ? el('button', { class: 'chip', style: 'margin-left:8px', onclick: () => { statPick = null; draw(); } }, '× Whole period') : null,
      el('span', { class: 'muted', style: 'margin-left:auto;font-size:12px', text: `Times in your local time (${localTz()})` })));
    host.appendChild(signupsPanel(w));
    host.appendChild(uploadsPanel(w));
  };
  draw();
  return host;
}

const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; } catch { return 'local'; } };
function dt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB',
    { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const profileHref = (u) => `profile.html?u=${encodeURIComponent(u)}`;
const linkStyle = 'color:inherit;font-weight:700;text-decoration:underline';
const PROVIDER = { google: 'Google', email: 'Email', telegram: 'Telegram', yandex: 'Yandex', apple: 'Apple', github: 'GitHub', anonymous: 'Guest' };
const providerLabel = (p) => (p ? p.split(/,\s*/).map(x => PROVIDER[x] || x).join(' + ') : '—');

/** Общая обвязка списка: заголовок, счётчик, «Show more». load(offset) → {rows,total}. */
function lazyList(title, hint, load, drawRow, opts = {}) {
  const list = el('div', { class: 'stat-list' }, el('div', { class: 'muted', text: 'Loading…' }));
  const count = el('span', { class: 'muted', style: 'font-size:13px' });
  const extra = el('div', {});
  const foot = el('div', {});
  const box = el('div', { class: 'side-card', style: 'margin-top:18px' },
    el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px' },
      el('div', { style: 'font-size:17px;font-weight:700', text: title }), count),
    el('div', { class: 'muted', style: 'font-size:12.5px;margin-bottom:8px', text: hint }), extra, list, foot);
  let shown = [], total = 0, offset = 0;
  const render = () => {
    clear(list);
    const vis = opts.filter ? shown.filter(opts.filter) : shown;
    if (!vis.length) list.appendChild(el('div', { class: 'muted', style: 'padding:10px 0', text: opts.empty || 'Nothing in this period.' }));
    vis.forEach(r => list.appendChild(drawRow(r)));
    count.textContent = `${total} total${opts.countNote ? opts.countNote(shown) : ''}`;
    clear(foot);
    if (offset < total) {
      const more = el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-top:12px' }, `Show more (${total - offset} left)`);
      more.onclick = () => { more.disabled = true; next(); };
      foot.appendChild(more);
    }
  };
  const next = async () => {
    let d;
    try { d = (await load(offset)).data || {}; }
    catch (e) { clear(foot).appendChild(el('div', { class: 'muted', text: e.message })); if (!shown.length) clear(list); return; }
    shown = shown.concat(d.rows || []); total = Number(d.total) || 0; offset += (d.rows || []).length;
    if (!(d.rows || []).length) offset = total;
    render();
  };
  if (opts.controls) extra.appendChild(opts.controls(render));
  next();
  return box;
}

let showGuests = false;
function signupsPanel(w) {
  return lazyList('Recent signups', 'Newest first. Email and sign-in method come from auth (admin only).',
    (offset) => call('recent_signups', { ...w, offset, limit: 25 }),
    (u) => {
      const name = u.display_name || u.username || '—';
      return el('div', { class: 'stat-row su-row' + (u.guest ? ' is-guest' : '') },
        el('div', { class: 'muted su-time', text: dt(u.created_at) }),
        el('div', { class: 'su-who' },
          u.username && !u.deleted_at
            ? el('a', { href: profileHref(u.username), target: '_blank', rel: 'noopener', style: linkStyle, text: name })
            : el('b', { text: name }),
          el('span', { class: 'muted', style: 'font-size:12.5px', text: ` @${u.username || '—'}${u.country ? ' · ' + flag(u.country) + ' ' + u.country : ''}` }),
          u.banned_at ? el('span', { class: 'pill', style: 'margin-left:6px;font-size:11px', text: 'banned' }) : null,
          el('div', { style: 'font-size:13px;word-break:break-all', text: u.email || (u.guest ? 'guest session (no account yet)' : '—') })),
        el('div', {}, el('span', { class: 'prov', text: providerLabel(u.provider) })),
        el('div', { class: 'su-links' },
          u.username ? el('a', { class: 'btn btn-ghost btn-sm', href: profileHref(u.username), target: '_blank', rel: 'noopener' }, 'Profile') : null,
          u.username ? el('button', { class: 'btn btn-ghost btn-sm', title: 'All albums incl. private and drafts (admin view)',
            onclick: () => renderUserAlbums(u.username, renderStats) }, `Albums (${u.albums_count ?? 0})`) : null));
    },
    {
      filter: (u) => showGuests || !u.guest,
      empty: 'No signups in this period.',
      countNote: (rows) => { const g = rows.filter(r => r.guest).length; return g ? ` · ${g} guest${g > 1 ? 's' : ''} loaded` : ''; },
      controls: (render) => {
        const cb = el('input', { type: 'checkbox' }); cb.checked = showGuests;
        cb.onchange = () => { showGuests = cb.checked; render(); };
        return el('label', { style: 'display:inline-flex;gap:6px;align-items:center;font-size:13px;margin-bottom:6px;cursor:pointer' },
          cb, 'Show guest sessions (anonymous uploaders)');
      },
    });
}

function uploadsPanel(w) {
  return lazyList('Albums with uploads', 'Albums where files were uploaded in this period, by last upload. Files = total in album now.',
    (offset) => call('recent_albums', { ...w, offset, limit: 25 }),
    (a) => {
      const tier = a.is_event ? (a.event_tier || 'small') : null;
      const type = tier
        ? tierChip(tier, 'event')
        : el('span', { class: 'prov', text: 'Personal' });
      return el('div', { class: 'stat-row up-row' },
        el('div', { class: 'up-title' },
          el('a', { href: `album.html?id=${a.id}`, target: '_blank', rel: 'noopener', style: linkStyle, text: a.title || 'Untitled' }),
          el('div', { class: 'muted', style: 'font-size:12.5px' }, 'by ',
            a.owner ? el('a', { href: profileHref(a.owner), target: '_blank', rel: 'noopener', style: 'color:inherit;text-decoration:underline', text: `@${a.owner}` }) : '—',
            ` · ${a.visibility || ''}${a.published_at ? '' : ' · draft'}`)),
        el('div', {}, type),
        el('div', { class: 'up-num' }, el('b', { text: String(a.files ?? 0) }), el('span', { class: 'muted', text: ' files' }),
          el('div', { class: 'muted', style: 'font-size:12px', text: `+${a.uploads || 0} in period` })),
        el('div', { class: 'up-time' }, el('div', { style: 'font-size:13.5px', text: dt(a.last_upload_at) }),
          el('div', { class: 'muted', style: 'font-size:12px', text: a.last_upload_at ? timeAgo(a.last_upload_at) : '' })),
        el('div', { class: 'su-links' },
          el('a', { class: 'btn btn-ghost btn-sm', href: `album.html?id=${a.id}`, target: '_blank', rel: 'noopener' }, 'Open'),
          el('a', { class: 'btn btn-ghost btn-sm', href: `moderation.html?album=${a.id}`, target: '_blank', rel: 'noopener' }, 'Moderate')));
    },
    { empty: 'No uploads in this period.', countNote: () => '' });
}

/* ---------------- все альбомы пользователя (вид админа) ---------------- */

const VIS_LABEL = { public: 'Public', friends: 'Friends', private: 'Private' };
const MOD_LABEL = { pending: 'Awaiting review', approved: 'Approved', rejected: 'Rejected' };

/** Почему альбом не виден в публичном профиле — коротко, для модератора. */
function whyHidden(a) {
  const r = [];
  if (!a.published_at) r.push('draft (not published)');
  if (a.visibility && a.visibility !== 'public') r.push(`${(VIS_LABEL[a.visibility] || a.visibility).toLowerCase()} visibility`);
  if (a.moderation_status && a.moderation_status !== 'approved') r.push((MOD_LABEL[a.moderation_status] || a.moderation_status).toLowerCase());
  if (a.hidden_at) r.push('hidden by moderator');
  if (!a.files) r.push('no files');
  return r;
}

async function renderUserAlbums(username, back) {
  clear(app);
  app.appendChild(head(`Albums of @${username}`, 'stats'));
  app.appendChild(el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-bottom:14px', onclick: () => (back || renderStats)() }, '← Back'));
  const body = el('div', {}, el('div', { class: 'muted', text: 'Loading…' }));
  app.appendChild(body);
  let d;
  try { d = (await call('user_albums', { username })).data || {}; }
  catch (e) { clear(body).appendChild(el('div', { class: 'muted', text: e.message === 'unknown_action' ? 'mod-api needs redeploying for this view (action user_albums).' : e.message })); return; }
  clear(body);
  const p = d.profile;
  if (!p) { body.appendChild(el('div', { class: 'muted', text: 'User not found.' })); return; }
  const rows = d.rows || [];
  body.appendChild(el('div', { class: 'side-card', style: 'display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center' },
    el('div', {},
      el('div', { style: 'font-size:18px;font-weight:800', text: p.display_name || p.username }),
      el('div', { class: 'muted', style: 'font-size:13px', text: `@${p.username} · joined ${dt(p.created_at)}${p.country ? ' · ' + flag(p.country) + ' ' + p.country : ''}${p.banned_at ? ' · banned' : ''}` })),
    el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      el('span', { class: 'muted', style: 'font-size:13px', text: `${rows.length} album${rows.length === 1 ? '' : 's'} · ${rows.filter(a => !whyHidden(a).length).length} visible on profile` }),
      el('a', { class: 'btn btn-ghost btn-sm', href: profileHref(p.username), target: '_blank', rel: 'noopener' }, 'Public profile'))));
  const list = el('div', { class: 'side-card', style: 'margin-top:18px' },
    el('div', { class: 'muted', style: 'font-size:12.5px;margin-bottom:6px', text: `All albums including private, drafts and hidden. Times in your local time (${localTz()}).` }));
  if (!rows.length) list.appendChild(el('div', { class: 'muted', style: 'padding:10px 0', text: 'This user has no albums.' }));
  rows.forEach(a => {
    const tier = a.is_event ? (a.event_tier || 'small') : null;
    const why = whyHidden(a);
    const chip = (text, warn) => el('span', { class: 'prov', style: warn ? 'background:#FBEFE6;border-color:#EBCDB6;color:#8A4B2F' : '', text });
    list.appendChild(el('div', { class: 'stat-row ua-row' },
      el('div', { class: 'up-title' },
        el('a', { href: `album.html?id=${a.id}`, target: '_blank', rel: 'noopener', style: linkStyle, text: a.title || 'Untitled' }),
        el('div', { style: 'display:flex;gap:4px;flex-wrap:wrap;margin-top:4px' },
          chip(VIS_LABEL[a.visibility] || a.visibility || '—', a.visibility !== 'public'),
          a.published_at ? chip('Published') : chip('Draft', true),
          chip(MOD_LABEL[a.moderation_status] || a.moderation_status || '—', a.moderation_status !== 'approved'),
          a.hidden_at ? chip('Hidden', true) : null),
        el('div', { class: 'muted', style: 'font-size:12px;margin-top:3px',
          text: why.length ? `Not on public profile: ${why.join(', ')}` : 'Visible on public profile' })),
      el('div', {}, tier ? tierChip(tier, 'event') : el('span', { class: 'prov', text: 'Personal' })),
      el('div', { class: 'up-num' }, el('b', { text: String(a.files ?? 0) }), el('span', { class: 'muted', text: ' files' }),
        el('div', { class: 'muted', style: 'font-size:12px', text: `${a.photos_count || 0} ph · ${a.videos_count || 0} vid · ${a.audio_count || 0} aud` })),
      el('div', { class: 'up-time' },
        el('div', { style: 'font-size:13px', text: `Created ${dt(a.created_at)}` }),
        el('div', { class: 'muted', style: 'font-size:12px', text: a.last_upload_at ? `Last upload ${dt(a.last_upload_at)}` : 'No uploads' })),
      el('div', { class: 'su-links' },
        el('a', { class: 'btn btn-ghost btn-sm', href: `album.html?id=${a.id}`, target: '_blank', rel: 'noopener' }, 'Open'),
        el('a', { class: 'btn btn-ghost btn-sm', href: `moderation.html?album=${a.id}`, target: '_blank', rel: 'noopener' }, 'Moderate'))));
  });
  body.appendChild(list);
}

// стили блока: одна вставка на страницу
document.head.appendChild(el('style', { text: `
.stat-charts{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}
@media (max-width:980px){.stat-charts{grid-template-columns:1fr}}
.stat-filter{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-top:22px;font-size:14px}
.stat-row{display:grid;gap:10px 14px;align-items:center;padding:10px 0;border-bottom:1px solid #F5F3EF;font-size:14px}
.stat-row:last-child{border-bottom:0}
.su-row{grid-template-columns:150px minmax(0,1fr) 110px auto}
.up-row{grid-template-columns:minmax(0,1.6fr) 110px 100px 150px auto}
.ua-row{grid-template-columns:minmax(0,1.6fr) 110px 110px 190px auto}
.su-links{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.prov{display:inline-block;font-size:12px;padding:2px 9px;border-radius:999px;background:#F5F1E8;border:1px solid #E4DCCE;white-space:nowrap}
.prov.warn{background:#FBEFE6;border-color:#EBCDB6;color:#8A4B2F}
.mq-group{margin-bottom:18px;display:flex;flex-direction:column;gap:14px}
.mq-focus{box-shadow:0 0 0 2px var(--accent)}
.mq-head{display:flex;justify-content:space-between;gap:12px 18px;flex-wrap:wrap;align-items:flex-start}
.mq-info{min-width:0;flex:1 1 320px}
.mq-kicker{font-size:11px;letter-spacing:.08em;font-weight:700;color:var(--muted,#8a8378)}
.mq-title{display:inline-block;font-size:19px;font-weight:800;color:inherit;text-decoration:underline;text-underline-offset:3px;word-break:break-word}
.mq-meta{font-size:13.5px;margin-top:2px}
.mq-desc{font-size:13.5px;margin-top:8px;max-width:640px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mq-links{display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
.mq-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.mq-card{border:1px solid #F0ECE4;border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:8px;background:#fff}
.mq-card-album{display:block;font-size:13.5px;font-weight:700;color:inherit;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mq-card-album:hover{text-decoration:underline}
.rs-filters{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:14px;margin:-6px 0 0}
.rs-chip{display:inline-block;font-size:11.5px;font-weight:700;letter-spacing:.02em;padding:2px 9px;border-radius:999px;border:1px solid;white-space:nowrap}
.rs-ok{background:#EAF5EC;border-color:#BFDCC5;color:#2F6B3B}
.rs-auto{background:#EAF0F8;border-color:#C3D3EA;color:#33557F}
.rs-wait{background:#FBF4E2;border-color:#EBD9A8;color:#7A5B12}
.rs-bad{background:#FBEAE6;border-color:#EDC2B8;color:#9A3B26}
.rs-row{display:grid;grid-template-columns:76px minmax(0,1fr) minmax(220px,auto);gap:12px 16px;align-items:center;padding:12px 0;border-bottom:1px solid #F5F3EF}
.rs-row:last-child{border-bottom:0}
.rs-thumb{width:76px;height:57px;border-radius:10px;overflow:hidden;background:#EFEDE8}
.rs-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.rs-line{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.rs-title{display:inline-block;margin-top:3px;font-size:16px;font-weight:800;color:inherit;text-decoration:underline;text-underline-offset:3px;word-break:break-word}
.rs-sub{font-size:12.5px;margin-top:2px}
.rs-banned{color:#B3452F;font-weight:700}
.rs-acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.rs-acts .mini,.mq-card .rowx .mini{text-decoration:none}
.rs-acts .mini:disabled,.mq-card .rowx .mini:disabled{opacity:.38;cursor:default;border-color:var(--line)}
.rs-onimg{position:absolute;top:8px;left:8px}
@media (max-width:720px){.rs-row{grid-template-columns:64px minmax(0,1fr)}.rs-thumb{width:64px;height:48px}.rs-acts{grid-column:1/-1;justify-content:flex-start}}
.mq-badge{position:absolute;top:8px;left:8px;background:rgba(20,18,15,.72);color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em;padding:3px 9px;border-radius:999px}
@media (max-width:720px){.mq-links{justify-content:flex-start}}
.is-guest{opacity:.6}
@media (max-width:720px){
  .su-row{grid-template-columns:1fr auto}
  .su-row .su-time{grid-column:1/-1;font-size:12.5px}
  .su-row .su-who{grid-column:1/-1}
  .up-row{grid-template-columns:1fr auto}
  .up-row .up-title{grid-column:1/-1}
  .ua-row{grid-template-columns:1fr auto}
  .ua-row .up-title{grid-column:1/-1}
  .su-links{justify-content:flex-start}
}
` }));

function gb(bytes) {
  const n = Number(bytes || 0);
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function secs(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (!s) return '—';
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------------- старт ---------------- */
// Ссылки из Telegram: moderation.html?album=<id> — альбом целиком;
// moderation.html?tab=media&album=<id> — очередь New media на группе этого альбома.
// Без них — New media: с 058 это единственная ежедневная очередь модератора.
const qs = new URLSearchParams(location.search);
const deepLink = qs.get('album');
const start = () => (qs.get('tab') === 'media' ? renderMedia(deepLink)
  : qs.get('tab') === 'albums' ? renderPending()
  : qs.get('tab') === 'recent-albums' ? renderRecentAlbums()
  : qs.get('tab') === 'recent-media' ? renderRecentMedia()
  : deepLink ? openAlbum(deepLink) : renderMedia());

if (token) start().catch(renderLogin);
else renderLogin();
