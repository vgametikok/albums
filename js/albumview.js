// Вёрстка содержимого альбома — одна на всех.
//
// Её используют и страница альбома, и панель модерации: модератор обязан видеть
// ровно то, что увидит зритель, включая подписи под кадрами, звук в видео,
// голосовые заметки, ГОЛОСОВЫЕ КАДРОВ И ГАЛЕРЕЙ и текстовые блоки. Поэтому код
// здесь, а не продублирован в двух местах.
//
// Отличия площадок задаются через opts:
//   refresh(el, path)            — переподпись протухшей ссылки (на сайте есть, в панели своя);
//   onImageClick(items, i, urls) — что делать по клику на фото (лайтбокс или новая вкладка).
import { el, clear, icon, playTriangle, dur, t } from './ui.js';

/** Соотношение сторон медиа; null, если размеры неизвестны. */
export function ratioOf(m) {
  const w = Number(m.width), h = Number(m.height);
  return (w > 0 && h > 0) ? w / h : null;
}

export function videoEl(m, urls, opts = {}) {
  const v = el('video', { controls: 'controls', preload: 'metadata', playsinline: 'playsinline' });
  if (urls[m.thumb]) v.poster = urls[m.thumb];
  if (urls[m.path]) v.src = urls[m.path];
  opts.refresh?.(v, m.path);
  const r = ratioOf(m);
  // Рамка по РЕАЛЬНЫМ пропорциям ролика: вертикальное видео остаётся вертикальным.
  if (r) v.style.aspectRatio = `${m.width} / ${m.height}`;
  else v.addEventListener('loadedmetadata', () => {
    if (v.videoWidth && v.videoHeight) v.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
  });
  return v;
}

/* Голосовая заметка: полоски-волнограмма детерминированы по id, прогресс — реальный. */
export function audioRow(m, urls, opts = {}) {
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
  opts.refresh?.(audio, m.path);
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
      el('div', { style: 'font-size:15px;font-weight:600', text: m.caption || t('voice_note') }),
      el('div', { style: 'font-size:13.5px;color:var(--faint);margin-top:2px', text: dur(m.duration) })),
    audio);
}

/* Плашка голосовой у кадра/галереи: маленький ▶ + длительность. Слушается и
 * без слайд-шоу; в статистику прослушиваний истории НЕ входит (решение). */
export function voiceChip(path, duration, urls, opts = {}) {
  const audio = el('audio', { preload: 'none' });
  if (urls[path]) audio.src = urls[path];
  opts.refresh?.(audio, path);
  const btn = el('button', { class: 'voice-chip-play', 'aria-label': t('voice_note') }, playTriangle(11));
  const setIcon = (playing) => {
    clear(btn);
    if (playing) {
      const s = el('span');
      s.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="#fff" style="display:block"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
      btn.appendChild(s.firstElementChild);
    } else btn.appendChild(playTriangle(11));
  };
  audio.onplay = () => setIcon(true);
  audio.onpause = () => setIcon(false);
  audio.onended = () => setIcon(false);
  const chip = el('div', { class: 'voice-chip', onclick: () => { audio.paused ? audio.play() : audio.pause(); } },
    btn, el('span', { text: `${t('voice_note')} · ${dur(duration) || '0:00'}` }), audio);
  return chip;
}

/**
 * Галерея в истории — горизонтальная лента, а не слайдер по одному кадру.
 *
 * Высота ряда общая, ширина каждого снимка — по его собственным пропорциям,
 * поэтому в ряд сами собой встают два вертикальных кадра и краешек третьего,
 * либо вертикальный и часть горизонтального, либо горизонтальный и часть
 * следующего. Выглядывающий край — приглашение листать дальше; у слайдера
 * с одним кадром по центру этого не было, а вертикальное фото оставляло
 * широкие пустые поля по бокам.
 *
 * Листается свайпом (нативная прокрутка со снапом), на десктопе — стрелками.
 */
function galleryStrip(members, urls, opts = {}) {
  const strip = el('div', { class: 'gal-strip' });
  members.forEach((m, i) => {
    // размеры бывают неизвестны у старых файлов — тогда берём типовые
    const ratio = ratioOf(m) || (m.kind === 'video' ? 16 / 9 : 3 / 2);
    const cell = el('div', { class: 'gal-shot', style: `aspect-ratio:${ratio}` });
    if (m.kind === 'video') {
      const v = videoEl(m, urls, opts);
      v.style.aspectRatio = '';          // пропорции держит сама ячейка
      cell.appendChild(v);
    } else {
      const img = el('img', {
        alt: m.caption || '', loading: 'lazy',
        onclick: () => opts.onImageClick?.(members, i, urls),
      });
      // как у одиночного кадра: сразу превью, оригинал подменяем как догрузится
      const full = urls[m.path], th = urls[m.thumb];
      if (th || full) img.src = th || full;
      if (full && th && full !== th) {
        const pre = new Image();
        pre.onload = () => { img.src = full; };
        pre.src = full;
      }
      if (opts.onImageClick) img.style.cursor = 'zoom-in';
      cell.appendChild(img);
    }
    if (m.caption) cell.appendChild(el('div', { class: 'gal-cap', text: m.caption }));
    strip.appendChild(cell);
  });

  const wrap = el('div', { class: 'gal-wrap' }, strip);
  if (members.length > 1) {
    // прокрутка почти на экран: последний видимый кадр остаётся зацепкой
    const go = (d) => strip.scrollBy({ left: d * strip.clientWidth * 0.85, behavior: 'smooth' });
    wrap.append(
      el('button', { class: 'gal-nav prev', 'aria-label': '←', onclick: () => go(-1) },
        icon('chevL', 18, { stroke: '#141414', sw: 2 })),
      el('button', { class: 'gal-nav next', 'aria-label': '→', onclick: () => go(1) },
        icon('chevR', 18, { stroke: '#141414', sw: 2 })));
  }
  return wrap;
}

/* История: блоки (кадр / галерея / текст) во всю ширину колонки, по позициям. */
function appendStoryBlocks(host, items, texts, galleries, urls, opts = {}) {
  const visual = items.filter(m => m.kind !== 'audio');
  const audio = items.filter(m => m.kind === 'audio');

  const entries = [
    ...visual.map(m => ({ type: 'm', pos: m.position ?? 0, m })),
    ...texts.map(x => ({ type: 'x', pos: x.position ?? 0, x })),
  ].sort((a, b) => (a.pos - b.pos) || (a.type === b.type ? 0 : a.type === 'm' ? -1 : 1));

  const blocks = [];
  for (const e of entries) {
    const last = blocks[blocks.length - 1];
    if (e.type === 'm' && e.m.gallery_id) {
      if (last?.type === 'g' && last.gid === e.m.gallery_id) last.members.push(e.m);
      else blocks.push({ type: 'g', gid: e.m.gallery_id, members: [e.m] });
    } else {
      blocks.push(e.type === 'm' ? { type: 'm', m: e.m } : { type: 'x', x: e.x });
    }
  }

  for (const b of blocks) {
    if (b.type === 'x') {
      host.appendChild(el('p', { class: 'story-text', text: b.x.body }));
      continue;
    }
    if (b.type === 'g') {
      const g = galleries.get(b.gid);
      const fig = el('div', { class: 'story-media' });
      fig.appendChild(galleryStrip(b.members, urls, opts));
      if (g?.voice_path) fig.appendChild(voiceChip(g.voice_path, g.voice_duration, urls, opts));
      host.appendChild(fig);
      continue;
    }
    const m = b.m;
    const i = visual.indexOf(m);
    const fig = el('div', { class: 'story-media' });
    if (m.kind === 'video') {
      fig.appendChild(videoEl(m, urls, opts));
    } else {
      const img = el('img', {
        alt: m.caption || '', loading: 'lazy',
        onclick: () => opts.onImageClick?.(visual, i, urls),
      });
      // сразу превью (лёгкое), оригинал подменяем как догрузится
      const full = urls[m.path], th = urls[m.thumb];
      if (th || full) img.src = th || full;
      if (full && th && full !== th) {
        const pre = new Image();
        pre.onload = () => { img.src = full; };
        pre.src = full;
      }
      if (opts.onImageClick) img.style.cursor = 'zoom-in';
      fig.appendChild(img);
    }
    if (m.caption) fig.appendChild(el('div', { class: 'story-cap', text: m.caption }));
    if (m.voice_path) fig.appendChild(voiceChip(m.voice_path, m.voice_duration, urls, opts));
    const mark = opts.mark?.(m);
    if (mark) fig.appendChild(mark);
    host.appendChild(fig);
  }
  audio.forEach(m => host.appendChild(audioRow(m, urls, opts)));
}

/* ---- режим «Story»: как в макете — главы с текстом, по порядку загрузки ---- */
export function renderStory(host, d, urls, opts = {}) {
  const galleries = new Map((d.galleries || []).map(g => [g.id, g]));
  const textsBy = new Map();
  for (const x of (d.texts || [])) {
    const k = x.chapter_id || '';
    if (!textsBy.has(k)) textsBy.set(k, []);
    textsBy.get(k).push(x);
  }

  for (const c of (d.chapters || [])) {
    const sec = el('div', { class: 'chapter' });
    if (c.label) sec.appendChild(el('div', { class: 'kicker', text: c.label.toUpperCase() }));
    if (c.title) sec.appendChild(el('h3', { text: c.title }));
    if (c.body) sec.appendChild(el('p', { text: c.body }));
    appendStoryBlocks(sec, c.media || [], textsBy.get(c.id) || [], galleries, urls, opts);
    host.appendChild(sec);
  }
  const looseTexts = textsBy.get('') || [];
  if ((d.loose || []).length || looseTexts.length) {
    const sec = el('div', { class: 'chapter' });
    if ((d.chapters || []).length) sec.appendChild(el('div', { class: 'kicker kicker-muted', text: t('more').toUpperCase() }));
    appendStoryBlocks(sec, d.loose || [], looseTexts, galleries, urls, opts);
    host.appendChild(sec);
  }
}
