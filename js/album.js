// Страница альбома: обложка, главы, медиа, голосовые заметки, сайдбар, комментарии.
import { sb, currentUser } from './sb.js';
import {
  el, $, clear, mountShell, signUrls, icon, playTriangle, toast, needAuth,
  composition, fmtCount, timeAgo, dur, avatarImg, emptyState, albumCard,
} from './ui.js';
import { mountComments } from './comments.js';

const app = $('#app');
const id = new URLSearchParams(location.search).get('id');

(async function main() {
  await mountShell('home');
  if (!id) { app.appendChild(emptyState('No album', 'This link has no album id.')); return; }

  app.appendChild(el('div', { class: 'skel', style: 'height:440px;border-radius:22px' }));
  const { data, error } = await sb.rpc('get_album', { p_id: id });
  clear(app);

  if (error) { app.appendChild(emptyState('Could not load', error.message)); return; }
  if (!data) {
    app.appendChild(emptyState('Album not available',
      'It may be private, shared with a different circle, or deleted.'));
    return;
  }
  render(data);
  sb.rpc('log_album_view', { p_id: id });
})();

async function render(d) {
  const a = d.album, author = d.author;
  document.title = `${a.title} — Albums`;

  // все медиа-пути одним батчем
  const paths = [a.cover_path];
  // Сквозной порядок «от первого к последнему загруженному»: position уникален в пределах альбома.
  const all = [...(d.chapters || []).flatMap(c => c.media || []), ...(d.loose || [])]
    .sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
  all.forEach(m => { paths.push(m.path, m.thumb); });
  const urls = await signUrls(paths);

  clear(app);
  app.appendChild(el('a', { class: 'back', href: 'index.html' }, icon('back', 16, { sw: 2 }), 'Back to feed'));

  /* ---- hero ---- */
  const hero = el('div', { class: 'album-hero' });
  if (urls[a.cover_path]) hero.appendChild(el('img', { src: urls[a.cover_path], alt: a.title }));

  const actions = el('div', { style: 'display:flex;align-items:center;justify-content:center;gap:12px;margin-top:22px;flex-wrap:wrap' });
  const watchBtn = el('button', { class: 'btn btn-primary', style: 'height:50px', onclick: watch },
    playTriangle(14), 'Watch album');
  actions.append(watchBtn, likeBtn(a, d.liked), saveBtn(a, d.saved), shareBtn());
  if (d.is_author) actions.appendChild(el('a', { class: 'btn btn-ghost', style: 'height:50px', href: `editor.html?id=${a.id}` }, 'Edit'));

  hero.appendChild(el('div', { class: 'hero-card' },
    el('div', { class: 'hero-inner' },
      a.category ? el('div', { class: 'kicker', text: a.category.toUpperCase() }) : null,
      el('div', { class: 'hero-title', text: a.title }),
      el('div', { class: 'hero-sub', text: `${author.name || author.username} · ${a.published_at ? new Date(a.published_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Draft'}` }),
      el('div', { class: 'pill', text: composition(a) }),
      actions)));
  app.appendChild(hero);

  /* ---- две колонки ---- */
  const left = el('div', { style: 'max-width:800px' });
  const right = el('aside', {});
  app.appendChild(el('div', { class: 'album-cols' }, left, right));

  if (a.description) left.appendChild(el('p', { class: 'lede', text: a.description }));

  /* ---- переключатель вида ---- */
  const body = el('div', {});
  if (all.length) {
    const modeRow = el('div', { style: 'margin-top:32px' });
    const toggle = el('div', { class: 'view-toggle' });
    const setMode = (m) => {
      localStorage.setItem('albumView', m);
      [...toggle.children].forEach(b => b.classList.toggle('on', b.dataset.mode === m));
      clear(body);
      if (m === 'grid') renderGrid(body, all, urls);
      else renderStory(body, d, urls);
    };
    [['story', 'Story'], ['grid', 'Grid']].forEach(([m, label]) => {
      toggle.appendChild(el('button', {
        'data-mode': m, onclick: () => setMode(m),
      }, label));
    });
    modeRow.appendChild(toggle);
    left.append(modeRow, body);
    setMode(localStorage.getItem('albumView') === 'grid' ? 'grid' : 'story');
  } else {
    left.appendChild(el('p', { class: 'muted', style: 'margin-top:32px', text: 'This album has no media yet.' }));
  }

  /* ---- сайдбар ---- */
  const side = el('div', { class: 'sticky' });
  side.appendChild(el('div', { class: 'side-card' },
    el('a', { href: `profile.html?u=${encodeURIComponent(author.username)}`, style: 'display:flex;gap:14px;align-items:center' },
      avatarImg(author.avatar, author.name, 56),
      el('div', { style: 'min-width:0' },
        el('div', { style: 'font-size:17px;font-weight:700', text: author.name || author.username }),
        el('div', { class: 'card-sub', text: '@' + author.username }))),
    el('div', { style: 'margin-top:18px;border-top:1px solid var(--line);padding-top:16px' },
      stat('In this album', composition(a)),
      stat('Views', fmtCount(a.views_count)),
      stat('Likes', fmtCount(a.likes_count)),
      stat('Published', a.published_at ? timeAgo(a.published_at) : 'Draft'))));
  right.appendChild(side);

  loadMore(side, author.username, a.id, urls);

  /* ---- комментарии ---- */
  const cHost = el('div', {});
  left.appendChild(cHost);
  mountComments(cHost, 'album', a.id, { isOwner: d.is_author });

  function watch() {
    const first = all.find(m => m.kind !== 'audio');
    if (!first) { toast('Nothing to watch yet'); return; }
    lightbox(all.filter(m => m.kind !== 'audio'), urls, 0);
  }
}

function stat(k, v) {
  return el('div', { style: 'display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:15px' },
    el('span', { class: 'muted', text: k }), el('b', { text: String(v) }));
}

/** Соотношение сторон медиа; null, если размеры неизвестны. */
function ratioOf(m) {
  const w = Number(m.width), h = Number(m.height);
  return (w > 0 && h > 0) ? w / h : null;
}

function videoEl(m, urls) {
  const v = el('video', { controls: 'controls', preload: 'metadata', playsinline: 'playsinline' });
  if (urls[m.thumb]) v.poster = urls[m.thumb];
  if (urls[m.path]) v.src = urls[m.path];
  const r = ratioOf(m);
  // Рамка по РЕАЛЬНЫМ пропорциям ролика: вертикальное видео остаётся вертикальным.
  if (r) v.style.aspectRatio = `${m.width} / ${m.height}`;
  else v.addEventListener('loadedmetadata', () => {
    if (v.videoWidth && v.videoHeight) v.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
  });
  return v;
}

/* ---- режим «Story»: как в макете — главы с текстом, по порядку загрузки ---- */
function renderStory(host, d, urls) {
  for (const c of (d.chapters || [])) {
    const sec = el('div', { class: 'chapter' });
    if (c.label) sec.appendChild(el('div', { class: 'kicker', text: c.label.toUpperCase() }));
    if (c.title) sec.appendChild(el('h3', { text: c.title }));
    if (c.body) sec.appendChild(el('p', { text: c.body }));
    appendMedia(sec, c.media || [], urls);
    host.appendChild(sec);
  }
  if ((d.loose || []).length) {
    const sec = el('div', { class: 'chapter' });
    if ((d.chapters || []).length) sec.appendChild(el('div', { class: 'kicker kicker-muted', text: 'MORE' }));
    appendMedia(sec, d.loose, urls);
    host.appendChild(sec);
  }
}

/* ---- режим «Grid»: адаптивная раскладка, ничего не обрезается ---- */
function renderGrid(host, all, urls) {
  const visual = all.filter(m => m.kind !== 'audio');
  const audio = all.filter(m => m.kind === 'audio');

  const wrap = el('div', { class: 'adaptive', style: 'margin-top:24px' });
  const cells = [];
  visual.forEach((m, i) => {
    const ratio = ratioOf(m) || (m.kind === 'video' ? 16 / 9 : 3 / 2);
    const cell = el('div', { class: 'cell' + (m.kind === 'video' ? ' video-cell' : '') });
    if (m.kind === 'video') {
      const v = videoEl(m, urls);
      v.style.aspectRatio = '';          // размер ячейки уже точен, кадр вписывается целиком
      cell.appendChild(v);
      if (m.duration) cell.appendChild(el('div', { class: 'vbadge', text: dur(m.duration) }));
    } else {
      const img = el('img', { alt: m.caption || '', loading: 'lazy', style: 'cursor:zoom-in' });
      if (urls[m.thumb] || urls[m.path]) img.src = urls[m.thumb] || urls[m.path];
      img.onclick = () => lightbox(visual, urls, i);
      cell.appendChild(img);
      if (m.caption) cell.appendChild(el('div', { class: 'cap', text: m.caption }));
    }
    cells.push({ el: cell, ratio });
    wrap.appendChild(cell);
  });
  host.appendChild(wrap);

  justify(wrap, cells);
  const onResize = () => justify(wrap, cells);
  addEventListener('resize', onResize, { passive: true });
  // страница живёт до перезагрузки, но если блок убрали — снимаем слушатель
  new MutationObserver((_, obs) => {
    if (!document.contains(wrap)) { removeEventListener('resize', onResize); obs.disconnect(); }
  }).observe(document.body, { childList: true, subtree: true });

  audio.forEach(m => host.appendChild(audioRow(m, urls)));
}

/**
 * Justified rows: набираем ряд, пока он не заполнит ширину, затем подбираем высоту
 * ряда так, чтобы он занял её ровно. Пропорции каждого медиа сохраняются точно.
 */
export function justify(wrap, cells, target = null, gap = 12) {
  const W = wrap.clientWidth;
  if (!W || !cells.length) return;
  const rowH = target || (W < 560 ? 180 : 260);

  let row = [], sum = 0;
  const flush = (isLast) => {
    if (!row.length) return;
    // -1px запаса: при точном попадании в ширину округление роняет последний элемент на новую строку
    const avail = W - gap * (row.length - 1) - 1;
    let h = avail / sum;
    // последний неполный ряд не растягиваем на всю ширину — иначе одиночное фото станет гигантским
    if (isLast && h > rowH * 1.35) h = rowH;
    row.forEach(c => {
      c.el.style.height = `${Math.round(h)}px`;
      c.el.style.width = `${Math.floor(h * c.ratio)}px`;   // floor, чтобы ряд не переполнялся
    });
    row = []; sum = 0;
  };

  for (const c of cells) {
    row.push(c); sum += c.ratio;
    if (sum * rowH + gap * (row.length - 1) >= W) flush(false);
  }
  flush(true);
}

function appendMedia(host, items, urls) {
  const visual = items.filter(m => m.kind !== 'audio');
  const audio = items.filter(m => m.kind === 'audio');
  if (visual.length) {
    const g = el('div', { class: 'media-grid g' + Math.min(3, visual.length) });
    visual.forEach((m, i) => {
      if (m.kind === 'video') {
        g.appendChild(videoEl(m, urls));
      } else {
        const img = el('img', { alt: m.caption || '', loading: 'lazy', onclick: () => lightbox(visual, urls, i) });
        if (urls[m.thumb] || urls[m.path]) img.src = urls[m.thumb] || urls[m.path];
        img.style.cursor = 'zoom-in';
        g.appendChild(img);
      }
    });
    host.appendChild(g);
  }
  audio.forEach(m => host.appendChild(audioRow(m, urls)));
}

/* Голосовая заметка: полоски-волнограмма детерминированы по id, прогресс — реальный. */
function audioRow(m, urls) {
  const bars = [];
  const wave = el('div', { class: 'wave' });
  let h = 0;
  for (let i = 0; i < (m.id || '').length; i++) h = (h * 31 + m.id.charCodeAt(i)) >>> 0;
  for (let i = 0; i < 40; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    const b = el('i', { style: `height:${8 + (h % 28)}px` });
    bars.push(b); wave.appendChild(b);
  }

  const audio = el('audio', { preload: 'none' });
  if (urls[m.path]) audio.src = urls[m.path];
  const btn = el('button', { class: 'audio-play' }, playTriangle(15));
  const setIcon = (playing) => {
    clear(btn);
    if (playing) {
      const s = el('span');
      s.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="#fff" style="display:block"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
      btn.appendChild(s.firstElementChild);
    } else btn.appendChild(playTriangle(15));
  };
  btn.onclick = () => { audio.paused ? audio.play() : audio.pause(); };
  audio.onplay = () => setIcon(true);
  audio.onpause = () => setIcon(false);
  audio.ontimeupdate = () => {
    const p = audio.duration ? audio.currentTime / audio.duration : 0;
    bars.forEach((b, i) => b.classList.toggle('on', i / bars.length <= p));
  };
  audio.onended = () => { setIcon(false); bars.forEach(b => b.classList.remove('on')); };

  return el('div', { class: 'audio-row' }, btn, wave,
    el('div', { style: 'text-align:right;flex-shrink:0' },
      el('div', { style: 'font-size:15px;font-weight:600', text: m.caption || 'Voice note' }),
      el('div', { style: 'font-size:13.5px;color:var(--faint);margin-top:2px', text: dur(m.duration) })),
    audio);
}

/* ---- лайтбокс «Watch» ---- */
function lightbox(items, urls, start) {
  let i = start;
  const stage = el('div', { style: 'position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center' });
  const draw = () => {
    clear(stage);
    const m = items[i];
    if (m.kind === 'video') {
      const v = el('video', { controls: 'controls', autoplay: 'autoplay', playsinline: 'playsinline', style: 'max-width:100%;max-height:100%' });
      if (urls[m.path]) v.src = urls[m.path];
      stage.appendChild(v);
    } else {
      const img = el('img', { alt: m.caption || '', style: 'max-width:100%;max-height:100%;object-fit:contain;border-radius:12px' });
      if (urls[m.path] || urls[m.thumb]) img.src = urls[m.path] || urls[m.thumb];
      stage.appendChild(img);
    }
    if (m.caption) stage.appendChild(el('div', {
      style: 'position:absolute;left:0;right:0;bottom:-34px;text-align:center;color:#fff;font-size:14.5px', text: m.caption,
    }));
  };

  const bg = el('div', {
    class: 'modal-bg',
    style: 'background:rgba(12,10,8,.92);flex-direction:column;gap:18px',
    onclick: (e) => { if (e.target === bg) close(); },
  });
  const nav = (dir) => el('button', {
    class: 'car-nav ' + (dir < 0 ? 'prev' : 'next'),
    style: 'position:static;transform:none',
    onclick: () => { i = (i + dir + items.length) % items.length; draw(); },
  }, icon(dir < 0 ? 'chevL' : 'chevR', 20, { stroke: '#141414', sw: 2 }));

  bg.append(
    el('div', { style: 'width:min(1100px,92vw);height:min(76vh,780px);position:relative' }, stage),
    el('div', { style: 'display:flex;gap:14px;align-items:center' },
      items.length > 1 ? nav(-1) : null,
      el('div', { style: 'color:#fff;font-size:14.5px', text: `${i + 1} / ${items.length}` }),
      items.length > 1 ? nav(1) : null,
      el('button', { class: 'car-nav', style: 'position:static;transform:none', onclick: () => close() },
        icon('x', 20, { stroke: '#141414', sw: 2 }))));

  function close() { bg.remove(); document.removeEventListener('keydown', key); }
  function key(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') { i = (i + 1) % items.length; draw(); }
    if (e.key === 'ArrowLeft') { i = (i - 1 + items.length) % items.length; draw(); }
  }
  document.addEventListener('keydown', key);
  draw();
  document.body.appendChild(bg);
}

/* ---- кнопки ---- */
function likeBtn(a, liked) {
  let on = !!liked;
  const b = el('button', { class: 'btn-round' + (on ? ' on' : '') });
  const paint = () => {
    clear(b);
    b.className = 'btn-round' + (on ? ' on' : '');
    b.appendChild(icon('heart', 20, { fill: on ? '#E8552B' : 'none', stroke: on ? '#E8552B' : '#141414' }));
  };
  b.onclick = async () => {
    if (!needAuth('Sign in to like albums')) return;
    const uid = currentUser().id;
    on = !on; paint();
    const q = on
      ? sb.from('likes').insert({ subject_type: 'album', subject_id: a.id, user_id: uid })
      : sb.from('likes').delete().eq('subject_type', 'album').eq('subject_id', a.id).eq('user_id', uid);
    const { error } = await q;
    if (error) { on = !on; paint(); toast('Could not update like'); }
  };
  paint();
  return b;
}

function saveBtn(a, saved) {
  let on = !!saved;
  const b = el('button', { class: 'btn-round' });
  const paint = () => {
    clear(b);
    b.className = 'btn-round' + (on ? ' on' : '');
    b.appendChild(icon('bookmark', 19, { fill: on ? '#E8552B' : 'none', stroke: on ? '#E8552B' : '#141414' }));
  };
  b.onclick = async () => {
    if (!needAuth('Sign in to save albums')) return;
    const uid = currentUser().id;
    on = !on; paint();
    const q = on
      ? sb.from('saves').insert({ album_id: a.id, user_id: uid })
      : sb.from('saves').delete().eq('album_id', a.id).eq('user_id', uid);
    const { error } = await q;
    if (error) { on = !on; paint(); toast('Could not update'); }
  };
  paint();
  return b;
}

function shareBtn() {
  return el('button', {
    class: 'btn-round',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        toast('Link copied');
      } catch (_) { toast(location.href); }
    },
  }, icon('share', 19));
}

async function loadMore(side, username, exceptId, urls) {
  const { data } = await sb.rpc('get_profile', { p_username: username });
  const others = (data?.albums || []).filter(x => x.id !== exceptId && x.published_at).slice(0, 3);
  if (!others.length) return;
  const more = await signUrls(others.map(o => o.cover_path || o.thumb1));
  const card = el('div', { class: 'side-card', style: 'margin-top:18px' },
    el('div', { class: 'kicker kicker-muted', style: 'margin-bottom:14px', text: 'MORE FROM THIS CREATOR' }));
  others.forEach(o => {
    const src = more[o.cover_path] || more[o.thumb1];
    const th = el('div', { style: 'width:76px;height:56px;border-radius:10px;overflow:hidden;background:var(--ph);flex-shrink:0' });
    if (src) th.appendChild(el('img', { src, alt: '', style: 'width:100%;height:100%;object-fit:cover' }));
    card.appendChild(el('a', {
      href: `album.html?id=${o.id}`, style: 'display:flex;gap:12px;align-items:center;padding:8px 0',
    }, th, el('div', { style: 'min-width:0' },
      el('div', { style: 'font-size:15.5px;font-weight:700;line-height:1.3', text: o.title }),
      el('div', { class: 'card-stat', text: composition(o) }))));
  });
  side.appendChild(card);
}
