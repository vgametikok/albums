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
      renderQueue();
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

/* ---------------- очередь ---------------- */
async function renderQueue() {
  clear(app);
  app.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:20px' },
    el('h1', { style: 'font-size:26px;font-weight:800;margin:0', text: 'Reports' }),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: logout }, 'Sign out')));

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

/* ---------------- старт ---------------- */
if (token) renderQueue().catch(renderLogin);
else renderLogin();
