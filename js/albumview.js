// Вёрстка содержимого альбома — одна на всех.
//
// Её используют и страница альбома, и панель модерации: модератор обязан видеть
// ровно то, что увидит зритель, включая подписи под кадрами, звук в видео и
// голосовые заметки. Поэтому код здесь, а не продублирован в двух местах.
//
// Отличия площадок задаются через opts:
//   refresh(el, path)            — переподпись протухшей ссылки (на сайте есть, в панели своя);
//   onImageClick(items, i, urls) — что делать по клику на фото (лайтбокс или новая вкладка).
import { el, clear, playTriangle, dur, t } from './ui.js';

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

/* История: медиа во всю ширину колонки, одно под другим, без обрезки. */
export function appendMedia(host, items, urls, opts = {}) {
  const visual = items.filter(m => m.kind !== 'audio');
  const audio = items.filter(m => m.kind === 'audio');
  visual.forEach((m, i) => {
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
    const mark = opts.mark?.(m);
    if (mark) fig.appendChild(mark);
    host.appendChild(fig);
  });
  audio.forEach(m => host.appendChild(audioRow(m, urls, opts)));
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

/* ---- режим «Story»: как в макете — главы с текстом, по порядку загрузки ---- */
export function renderStory(host, d, urls, opts = {}) {
  for (const c of (d.chapters || [])) {
    const sec = el('div', { class: 'chapter' });
    if (c.label) sec.appendChild(el('div', { class: 'kicker', text: c.label.toUpperCase() }));
    if (c.title) sec.appendChild(el('h3', { text: c.title }));
    if (c.body) sec.appendChild(el('p', { text: c.body }));
    appendMedia(sec, c.media || [], urls, opts);
    host.appendChild(sec);
  }
  if ((d.loose || []).length) {
    const sec = el('div', { class: 'chapter' });
    if ((d.chapters || []).length) sec.appendChild(el('div', { class: 'kicker kicker-muted', text: t('more').toUpperCase() }));
    appendMedia(sec, d.loose, urls, opts);
    host.appendChild(sec);
  }
}
