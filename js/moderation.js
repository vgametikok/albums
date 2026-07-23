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
  const err = el('div', { class: 'muted', style: 'color:#c0392b;margin-top:10px;min-height:20px' });
  const btn = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:14px' }, 'Enter');

  btn.onclick = async () => {
    btn.disabled = true; err.textContent = '';
    try {
      const r = await call('login', { login: login.value, password: pass.value });
      token = r.token;
      sessionStorage.setItem('modToken', token);
      renderPending();
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
      el('h3', { text: 'Nothing to review' }),
      el('div', { text: 'Every published album has been reviewed.' })));
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
  if (!d) { clear(app).appendChild(el('div', { class: 'muted', text: 'Album not found' })); return; }

  const a = d.album, author = d.author || {};
  const all = [...(d.chapters || []).flatMap(c => c.media || []), ...(d.loose || [])];
  const paths = [a.cover_path, ...all.flatMap(m => [m.path, m.thumb]), d.narration?.path];
  const urls = await signPaths(paths);

  clear(app);
  app.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;flex-wrap:wrap' },
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => renderPending() }, '← Back to queue'),
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
  if (all.length) renderStory(body, d, urls, VIEW);
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
    renderPending();
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

/* ---------------- продуктовая статистика ---------------- */
let statDays = 30;

async function renderStats() {
  clear(app);
  app.appendChild(head('Statistics', 'stats'));

  const bar = el('div', { class: 'rowx', style: 'margin-bottom:18px' });
  [7, 30, 90].forEach(n => bar.appendChild(el('button', {
    class: 'chip' + (statDays === n ? ' on' : ''),
    onclick: () => { statDays = n; renderStats(); },
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
  ]));

  body.appendChild(panel('By day', dayTable(d.by_day || [])));
  body.appendChild(panel('Countries', barList((d.geo || []).map(g => [g.code || '??', g.n]))));
  body.appendChild(panel('Top albums', topList(d.top_albums || [])));
  body.appendChild(planForm());
  body.appendChild(eventForm());
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
  const live = rows.filter(r => r.views || r.actives || r.signups || r.albums);
  if (!live.length) return el('div', { class: 'muted', text: 'Nothing happened in this period.' });
  const line = (cells, muted) => el('div', {
    class: muted ? 'muted' : '',
    style: 'display:grid;grid-template-columns:1.4fr repeat(4,1fr);gap:8px;padding:6px 0;font-size:14px'
      + (muted ? ';border-bottom:1px solid #EFEDE8;font-size:12.5px' : ';border-bottom:1px solid #F5F3EF'),
  }, ...cells.map(x => el('span', { text: String(x) })));
  const box = el('div', {}, line(['Day', 'Visits', 'Active', 'Signups', 'Albums'], true));
  live.forEach(r => box.appendChild(line([r.day, r.views, r.actives, r.signups, r.albums])));
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
      el('i', { style: `display:block;height:100%;border-radius:99px;background:#E8552B;width:${Math.max(3, (n / max) * 100)}%` })))));
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
function eventForm() {
  const user = el('input', { class: 'input', placeholder: 'username', autocomplete: 'off' });
  const count = el('input', { class: 'input', type: 'number', value: '1', min: '-20', max: '20' });
  const out = el('div', { class: 'muted', style: 'font-size:13.5px;min-height:20px' });
  const go = el('button', { class: 'btn btn-primary btn-sm' }, 'Grant');
  go.onclick = async () => {
    go.disabled = true;
    try {
      const r = await call('grant_event', {
        username: user.value.trim(), count: parseInt(count.value, 10) || 0,
      });
      out.textContent = r.data?.error
        ? 'User not found'
        : `${r.data.username}: ${r.data.credits} left · ${r.data.events} created`;
      toast('Done');
    } catch (e) { out.textContent = e.message; }
    go.disabled = false;
  };
  return panel('Event albums', el('div', { class: 'stack' },
    el('div', { class: 'muted', style: 'font-size:13.5px',
      text: 'One paid Event Album = one credit. The user then sees "Shared album" in their profile, creates it and gets a permanent QR for guests. Negative number takes credits back.' }),
    user, count, go, out));
}

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
// Первым делом — очередь новых альбомов: это ежедневная работа модератора.
if (token) renderPending().catch(renderLogin);
else renderLogin();
