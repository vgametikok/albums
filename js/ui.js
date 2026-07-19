// Общие UI-помощники: безопасный DOM, шапка, подписанные URL, карточки, модалки.
import { sb, ready, currentUser, currentProfile, isAuthed, signIn, signOut } from './sb.js';
import {
  t, initI18n, fmtNumber, fmtTimeAgo, composition, catLabel,
  LANGS, currentLang, setLang,
} from './i18n.js';

// Форматирование и склонения живут в i18n, но исторически импортируются отсюда.
export { t, composition, catLabel, LANGS, currentLang, setLang };
export const fmtCount = fmtNumber;
export const timeAgo = fmtTimeAgo;

/* ---------------- безопасный DOM ---------------- */
// Текст всегда через textContent — пользовательские данные никогда не идут в innerHTML.
export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;          // только для статических иконок
    else if (k === 'style') n.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return n;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

/* ---------------- иконки (статические) ---------------- */
const I = {
  search: '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  comment: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  chevL: '<path d="M15 18l-6-6 6-6"/>',
  chevR: '<path d="M9 18l6-6-6-6"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 16 0v1"/>',
};
export function icon(name, size = 20, opts = {}) {
  const s = el('span', { class: 'ic' });
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${opts.fill || 'none'}"
    stroke="${opts.stroke || 'currentColor'}" stroke-width="${opts.sw || 1.8}"
    stroke-linecap="round" stroke-linejoin="round" style="display:block">${I[name] || ''}</svg>`;
  return s.firstElementChild;
}
export function playTriangle(size = 13, color = '#fff') {
  const s = el('span');
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}"
    style="display:block;margin-left:2px"><polygon points="6,4 20,12 6,20"/></svg>`;
  return s.firstElementChild;
}

/* ---------------- форматирование ---------------- */
export function dur(sec) {
  if (!sec) return '';
  const s = Math.round(Number(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------------- подписанные URL для приватного бакета ---------------- */
const urlCache = new Map();
export async function signUrls(paths) {
  const now = Date.now();
  const need = [...new Set(paths.filter(p => p && !(urlCache.get(p)?.exp > now)))];
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const { data } = await sb.storage.from('media').createSignedUrls(chunk, 3600);
    (data || []).forEach(d => {
      if (d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, exp: now + 3400e3 });
    });
  }
  const out = {};
  for (const p of paths) if (p && urlCache.get(p)) out[p] = urlCache.get(p).url;
  return out;
}

/* ---------------- toast ---------------- */
let toastTimer = null;
export function toast(msg) {
  const old = $('.toast'); if (old) old.remove();
  const t = el('div', { class: 'toast', text: msg });
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

/* ---------------- модалки ---------------- */
export function modal(build, opts = {}) {
  const box = el('div', { class: 'modal' + (opts.wide ? ' wide' : '') });
  const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } }, box);
  function close() { bg.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  build(box, close);
  document.body.appendChild(bg);
  return close;
}

export function showLogin(reason) {
  modal((box, close) => {
    box.append(
      el('h2', { text: t('welcome_title') }),
      el('p', { text: reason || t('signin_reason_default') }),
      el('button', {
        class: 'btn btn-primary', style: 'width:100%',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await signIn(); } catch (err) { toast(err.message || t('signin_failed')); e.currentTarget.disabled = false; }
        },
      }, t('continue_google')),
      el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, t('not_now')),
    );
  });
}

/** Возвращает true, если пользователь авторизован; иначе открывает модалку. */
export function needAuth(reason) {
  if (isAuthed()) return true;
  showLogin(reason);
  return false;
}

/* ---------------- шапка ---------------- */
export async function mountShell(active) {
  await Promise.all([ready(), initI18n()]);
  const host = $('#shell');
  if (!host) return;
  const me = currentProfile();

  const searchInput = el('input', {
    placeholder: t('search_ph'),
    value: new URLSearchParams(location.search).get('q') || '',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        const q = e.currentTarget.value.trim();
        location.href = q ? `index.html?q=${encodeURIComponent(q)}` : 'index.html';
      }
    },
  });

  const right = el('div', { class: 'hdr-right' });
  right.append(
    el('a', { class: 'nav-link hide-sm' + (active === 'posts' ? ' active' : ''), href: 'posts.html' }, t('nav_posts')),
    el('a', { class: 'nav-link hide-sm' + (active === 'friends' ? ' active' : ''), href: 'friends.html' }, t('nav_friends')),
    el('a', { class: 'btn btn-primary', href: 'editor.html' }, icon('plus', 18, { sw: 2.4 }), t('new_album')),
    langPicker(),
  );

  if (me) {
    const { notifButton } = await import('./notifications.js');
    right.append(
      notifButton(),
      el('a', { href: `profile.html?u=${encodeURIComponent(me.username)}`, style: 'flex-shrink:0' },
        avatarImg(me.avatar_url, me.display_name, 44)));
  } else {
    right.append(el('button', {
      class: 'btn btn-ghost', onclick: () => showLogin(t('signin_to_create')),
    }, t('sign_in')));
  }

  clear(host).append(el('header', { class: 'hdr' },
    el('a', { class: 'logo', href: 'index.html' }, 'Albums'),
    el('div', { class: 'search-wrap' },
      el('div', { class: 'search' }, icon('search', 20, { stroke: '#8F8B84', sw: 2 }), searchInput)),
    right,
  ));

  mountMobileNav(active, me);
}

/**
 * Нижняя панель на телефоне. Раньше «Посты» и «Друзья» были в шапке с классом
 * hide-sm и на узком экране просто исчезали — попасть в ленту постов с телефона
 * было невозможно вообще.
 */
function mountMobileNav(active, me) {
  document.querySelector('.mobnav')?.remove();
  const item = (key, href, iconName, label) => el('a', {
    class: 'mobnav-item' + (active === key ? ' on' : ''), href,
  }, icon(iconName, 22, { sw: active === key ? 2.2 : 1.8 }), el('span', { text: label }));

  document.body.appendChild(el('nav', { class: 'mobnav' },
    item('home', 'index.html', 'home', t('nav_home')),
    item('posts', 'posts.html', 'grid', t('nav_posts')),
    el('a', { class: 'mobnav-item mobnav-add', href: 'editor.html', 'aria-label': t('new_album') },
      icon('plus', 24, { sw: 2.6, stroke: '#fff' })),
    item('friends', 'friends.html', 'users', t('nav_friends')),
    me
      ? item('profile', `profile.html?u=${encodeURIComponent(me.username)}`, 'user', t('nav_profile'))
      : el('button', { class: 'mobnav-item', onclick: () => showLogin(t('signin_to_create')) },
          icon('user', 22), el('span', { text: t('sign_in') })),
  ));
  document.body.classList.add('has-mobnav');
}

/** Переключатель языка. Выбор запоминается и применяется перезагрузкой страницы. */
function langPicker() {
  const sel = el('select', {
    class: 'lang-select', title: t('language'), 'aria-label': t('language'),
    onchange: (e) => setLang(e.currentTarget.value),
  });
  for (const [code, label] of Object.entries(LANGS)) {
    sel.appendChild(el('option', { value: code, selected: code === currentLang() ? 'selected' : null }, label));
  }
  return sel;
}

/**
 * Превью медиа для карточек. Если постера нет и подставлен сам ролик, показываем
 * <video> с меткой #t=0.1 — браузер отрисует кадр без воспроизведения. Раньше путь
 * к .mp4 попадал в <img>, и на месте превью была битая картинка.
 */
export function thumbEl(path, url, kind, alt = '') {
  if (!url) return null;
  const isVideoFile = kind === 'video' && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(String(path || ''));
  if (!isVideoFile) return el('img', { src: url, alt, loading: 'lazy' });
  const v = el('video', {
    src: url + '#t=0.1', preload: 'metadata', muted: 'muted',
    playsinline: 'playsinline', tabindex: '-1', 'aria-label': alt,
  });
  v.controls = false;
  return v;
}

export function avatarImg(url, name, size = 44) {
  const img = el('img', {
    class: 'avatar', alt: name || 'avatar',
    style: `width:${size}px;height:${size}px`,
    referrerpolicy: 'no-referrer',
  });
  if (url) img.src = url;
  return img;
}

/* ---------------- карточка альбома ---------------- */
export function albumCard(a, urls = {}, opts = {}) {
  const href = `album.html?id=${a.id}`;
  const cover = urls[a.cover_path || a.cover] || urls[a.thumb1_path || a.thumb1] || null;
  const t1 = urls[a.thumb1_path || a.thumb1] || null;
  const t2 = urls[a.thumb2_path || a.thumb2] || null;

  const cell = (path, src, kind) => {
    const c = el('div', {});
    const node = thumbEl(path, src, kind);
    if (node) c.appendChild(node);
    if (kind === 'video') c.appendChild(el('div', { class: 'play-dot' }, el('i', {}, playTriangle(13))));
    return c;
  };

  const coverPath = a.cover_path || a.cover || a.thumb1_path || a.thumb1;
  const coverKind = (a.cover_path || a.cover) ? null : (a.thumb1_kind || a.thumb1_type);
  const big = el('div', { class: 'big' });
  const coverNode = thumbEl(coverPath, cover, coverKind, a.title || '');
  if (coverNode) big.appendChild(coverNode);

  const link = el('a', { class: 'card-cover', href },
    el('div', { class: 'mosaic' }, big,
      cell(a.thumb1_path || a.thumb1, t1, a.thumb1_kind || a.thumb1_type),
      cell(a.thumb2_path || a.thumb2, t2, a.thumb2_kind || a.thumb2_type)),
    el('div', { class: 'badge' },
      (a.videos_count > 0 ? playTriangle(11) : null), composition(a)),
    (a.visibility && a.visibility !== 'public'
      ? el('div', { class: 'badge badge-lock' }, icon(a.visibility === 'friends' ? 'users' : 'lock', 12, { sw: 2 }),
          a.visibility === 'friends' ? t('friends') : t('private'))
      : null),
  );

  const meta = el('div', { class: 'card-meta' });
  if (!opts.hideAuthor && a.author_username) {
    meta.appendChild(el('a', { href: `profile.html?u=${encodeURIComponent(a.author_username)}`, style: 'flex-shrink:0' },
      avatarImg(a.author_avatar, a.author_name, 44)));
  }
  const info = el('div', { style: 'min-width:0' },
    el('a', { class: 'card-title', href, text: a.title }));
  if (!opts.hideAuthor && a.author_username) {
    info.appendChild(el('a', {
      class: 'card-sub', href: `profile.html?u=${encodeURIComponent(a.author_username)}`,
      text: a.author_name || a.author_username,
    }));
  }
  info.appendChild(el('div', {
    class: 'card-stat',
    text: `${t('n_views', { count: a.views_count || 0 })} · ${fmtTimeAgo(a.published_at)}`,
  }));
  meta.appendChild(info);

  return el('div', {}, link, meta);
}

export function skeletonGrid(n = 8) {
  const g = el('div', { class: 'grid' });
  for (let i = 0; i < n; i++) {
    g.appendChild(el('div', {},
      el('div', { class: 'skel', style: 'aspect-ratio:3/2' }),
      el('div', { class: 'skel', style: 'height:18px;margin-top:14px;width:70%;border-radius:6px' }),
      el('div', { class: 'skel', style: 'height:14px;margin-top:8px;width:45%;border-radius:6px' })));
  }
  return g;
}

export function emptyState(title, text, action) {
  const box = el('div', { class: 'empty' }, el('h3', { text: title }), el('div', { text: text || '' }));
  if (action) box.appendChild(el('div', { style: 'margin-top:20px' }, action));
  return box;
}

export { signOut };
