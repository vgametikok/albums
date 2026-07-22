// Панель модерации. Отдельная страница, вход по паролю (проверяется в edge-функции
// mod-api). Пользовательская авторизация Albums тут ни при чём — у модератора своя.
// Токен сессии живёт в sessionStorage: закрыл вкладку — вышел.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { el, clear, icon, toast } from './ui.js';

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
        class: 'chip btn-sm' + (active ==='pending' ? ' on' : ''),
        onclick: () => renderPending(),
      }, pendingCount === null ? 'New albums' : `New albums (${pendingCount})`),
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

async function renderPending() {
  clear(app);
  app.appendChild(head('New albums', 'pending'));

  const list = el('div', { class: 'stack' });
  app.appendChild(list);
  list.appendChild(el('div', { class: 'muted', text: 'Loading…' }));

  let d;
  try { d = (await call('pending')).data; }
  catch (e) { clear(list).appendChild(el('div', { class: 'muted', text: e.message })); return; }

  pendingCount = d?.count ?? 0;
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
    el('button', { class: 'mini', onclick: () => openSubject({ subject_type: 'album', subject_id: a.id }) }, 'Open'),
    el('button', { class: 'mini', onclick: () => decide(true) }, 'Approve'),
    el('button', { class: 'mini danger', onclick: () => decide(false) }, 'Reject')));
  return card;
}

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
