// Общий полноэкранный плеер «Истории» — один на оба режима озвучки:
//
//   «рассказ»   (вариант 1, миграция 012) — один трек на альбом, кадры
//               сменяются по меткам narration_cues;
//   «голосовые» (вариант 2, миграция 034) — виртуальная склейка: плеер играет
//               голосовые дорожки кадров и галерей ПОДРЯД, единый таймлайн
//               рисуется поверх (кумулятивные смещения, ничего не
//               перекодируется).
//
// Технические решения:
//   - ОДИН <audio> на весь показ, src переключается между дорожками: iOS
//     разрешает программный play() только на элементе, уже активированном
//     жестом пользователя. Если история начинается с немого кадра, элемент
//     разблокируется первым жестом принудительно (play->pause первой дорожки).
//   - Длительности дорожек могут отсутствовать в базе (Chrome у webm-записей
//     с микрофона отдаёт Infinity) — тогда сегмент дотягивается по
//     loadedmetadata/durationchange, таймлайн и метки пересчитываются.
//   - Кадр без голосовой — SILENT_SEC секунды тишины (таймер, не дорожка).
//   - Видео без голосовой играет СО СВОИМ звуком целиком; с голосовой — немое
//     на длительность дорожки (как в варианте 1).
//   - Галерея с голосовой — один сегмент: кадры сменяются каждые dur/n.
//   - Прослушивание: 5 секунд РЕАЛЬНОГО продвижения таймлайна (паузы и
//     зависшие дорожки не считаются) -> один stat_listen; ошибки статистики
//     глушатся.
import { sb } from './sb.js';
import { el, clear, dur as fmtDur, t, resignUrl, attachMediaRefresh, playTriangle } from './ui.js';
import { country, lang } from './stats.js';

const SILENT_SEC = 2.5;          // немой кадр в истории
const LISTEN_AT_MS = 5000;       // порог засчитанного прослушивания

/* ================================================== сегменты варианта 2 */

/**
 * Собирает историю из данных get_album: кадры в порядке повествования
 * (главы по позициям, затем прочее), подряд идущие кадры одной галереи —
 * один блок. Возвращает { segments, total, voiced }.
 *
 * Сегмент: { frames:[m], dur, durGuess, track|null, trackPath|null, ownSound }.
 * durGuess = длительности в базе не было, плеер уточнит её по метаданным.
 * У галереи без общей голосовой кадры идут отдельными сегментами — так
 * играет и голос, случайно оставшийся на кадре до объединения.
 */
export function buildVoiceSegments(d, urls) {
  const galleries = new Map((d.galleries || []).map(g => [g.id, g]));
  const ordered = [...(d.chapters || []).flatMap(c => c.media || []), ...(d.loose || [])]
    .filter(m => m.kind !== 'audio');

  const blocks = [];
  for (const m of ordered) {
    const last = blocks[blocks.length - 1];
    if (m.gallery_id && last && last.galleryId === m.gallery_id) last.frames.push(m);
    else blocks.push({ galleryId: m.gallery_id || null, frames: [m] });
  }

  const segments = [];
  let voiced = 0;
  const single = (m) => {
    if (m.voice_path) {
      voiced++;
      const vd = Number(m.voice_duration);
      segments.push({ frames: [m], dur: vd > 0 ? vd : SILENT_SEC, durGuess: !(vd > 0),
                      track: urls[m.voice_path] || null, trackPath: m.voice_path, ownSound: false });
    } else if (m.kind === 'video') {
      const md = Number(m.duration);
      segments.push({ frames: [m], dur: md > 0 ? md : SILENT_SEC, durGuess: !(md > 0),
                      track: null, trackPath: null, ownSound: true });
    } else {
      segments.push({ frames: [m], dur: SILENT_SEC, durGuess: false, track: null, trackPath: null, ownSound: false });
    }
  };
  for (const b of blocks) {
    const g = b.galleryId ? galleries.get(b.galleryId) : null;
    if (g && g.voice_path && b.frames.length) {
      voiced++;
      const gd = Number(g.voice_duration);
      segments.push({ frames: b.frames, dur: gd > 0 ? gd : SILENT_SEC, durGuess: !(gd > 0),
                      track: urls[g.voice_path] || null, trackPath: g.voice_path, ownSound: false });
    } else {
      b.frames.forEach(single);
    }
  }
  const total = segments.reduce((s, x) => s + x.dur, 0);
  return { segments, total, voiced };
}

/* ================================================== публичные входы */

/** Вариант 2: сборка из голосовых. */
export function openVoicesShow({ albumId, segments, total, urls }) {
  openShow({ albumId, segments, total, urls, cueTicks: null });
}

/** Вариант 1: единый рассказ + метки. Поведение прежнего плеера сохранено. */
export function openNarrationShow({ albumId, audioUrl, audioPath, duration, cues, mediaItems, urls }) {
  const frames = cues
    .map(c => ({ at: c.at, m: mediaItems.find(x => x.am_id === c.id) }))
    .filter(f => f.m);
  if (!frames.length) return;
  const d = Number(duration);
  openShow({
    albumId, urls,
    segments: [{
      frames: frames.map(f => f.m), cueTimes: frames.map(f => f.at),
      dur: d > 0 ? d : 0, durGuess: !(d > 0),
      track: audioUrl, trackPath: audioPath, ownSound: false,
    }],
    total: d > 0 ? d : 0,
    cueTicks: frames.map(f => f.at),
  });
}

/* ================================================== сам плеер */

function segStarts(segments) {
  const starts = [];
  let acc = 0;
  for (const s of segments) { starts.push(acc); acc += s.dur; }
  return starts;
}

function openShow({ albumId, segments, total, urls, cueTicks }) {
  if (!segments.length) return;
  let totalDur = Math.max(Number(total) || 0, 0);
  // без известной длительности открываться имеет смысл, только если есть
  // дорожка, по метаданным которой длительность дотянется
  if (!(totalDur > 0) && !segments.some(s => s.track)) return;
  let starts = segStarts(segments);

  /* ---------- сцена ---------- */
  const stage = el('div', { class: 'narr-stage' });
  let shownKey = null;
  let stageVideo = null;         // видео текущего кадра (для ownSound-сегментов)

  // Кадр сегмента seg на локальной секунде lt. У рассказа кадр выбирает метка,
  // у галереи — равномерная нарезка, у одиночного кадра он один.
  const frameOf = (seg2, lt) => {
    if (seg2.cueTimes) {
      let i = 0;
      for (let k = 0; k < seg2.cueTimes.length; k++) if (seg2.cueTimes[k] <= lt + 0.05) i = k;
      return { m: seg2.frames[i], key: 'c' + i };
    }
    if (seg2.frames.length === 1) return { m: seg2.frames[0], key: 's0' };
    const step = Math.max(seg2.dur, 0.1) / seg2.frames.length;
    const i = Math.min(seg2.frames.length - 1, Math.floor(lt / step));
    return { m: seg2.frames[i], key: 'g' + i };
  };

  const drawFrame = (segIdx, lt) => {
    const s = segments[segIdx];
    const { m, key } = frameOf(s, lt);
    const fullKey = segIdx + '/' + key;
    if (!m || fullKey === shownKey) return;
    shownKey = fullKey;
    clear(stage);
    stageVideo = null;
    if (m.kind === 'video') {
      const v = el('video', { playsinline: 'playsinline' });
      if (urls[m.thumb]) v.poster = urls[m.thumb];
      if (urls[m.path]) v.src = urls[m.path];
      attachMediaRefresh(v, m.path);
      if (s.ownSound) {
        // видео говорит само; звук может быть запрещён автоплей-политикой —
        // тогда играем немым, таймлайн ведёт время видео в любом случае
        v.muted = false;
        stageVideo = v;
      } else {
        v.muted = true;
        v.loop = true;
        v.autoplay = true;
        v.play?.().catch?.(() => {});
      }
      stage.appendChild(v);
    } else {
      const img = el('img', { alt: m.caption || '' });
      const full = urls[m.path], th = urls[m.thumb];
      if (th || full) img.src = th || full;
      if (full && th && full !== th) {
        const pre = new Image();
        pre.onload = () => { img.src = full; };
        pre.src = full;
      }
      stage.appendChild(img);
    }
    if (m.caption) stage.appendChild(el('div', { class: 'narr-show-cap', text: m.caption }));
  };

  /* ---------- источник времени ---------- */
  const audio = el('audio', { preload: 'auto' });
  let seg = 0;                   // индекс текущего сегмента
  let playing = false;
  let silentBase = 0;            // накопленная тишина текущего сегмента, сек
  let silentFrom = 0;            // performance.now() старта отсчёта тишины
  let ended = false;

  const localTime = () => {
    const s = segments[seg];
    if (s.track) return Math.min(audio.currentTime || 0, s.dur);
    if (s.ownSound && stageVideo) return Math.min(stageVideo.currentTime || 0, s.dur);
    return Math.min(silentBase + (playing ? (performance.now() - silentFrom) / 1000 : 0), s.dur);
  };
  const globalTime = () => starts[seg] + localTime();

  // Протухшая R2-ссылка дорожки: ОДИН обработчик на весь показ, путь берётся
  // из текущего сегмента (вешать attachMediaRefresh на каждый arm нельзя —
  // обработчики копились бы и наперегонки переписывали src).
  let lastResign = 0;
  audio.addEventListener('error', async () => {
    const s = segments[seg];
    if (!s?.track || !s.trackPath) return;
    const now = Date.now();
    if (now - lastResign < 30000) return;
    lastResign = now;
    const fresh = await resignUrl(s.trackPath);
    if (!fresh) return;
    const pos = localTime();
    s.track = fresh;
    audio.src = fresh;
    try { audio.currentTime = pos; } catch (_) { /* no-op */ }
    if (playing) audio.play().catch(() => {});
  });

  // Длительности не было в базе — дотягиваем по метаданным текущей дорожки.
  audio.addEventListener('durationchange', () => {
    const s = segments[seg];
    if (s?.track && s.durGuess && isFinite(audio.duration) && audio.duration > 0) {
      s.dur = audio.duration;
      s.durGuess = false;
      recompute();
    }
  });

  // Запуск источника текущего сегмента с локальной секунды lt.
  const arm = (lt) => {
    const s = segments[seg];
    audio.pause();
    drawFrame(seg, lt);
    if (s.track) {
      if (audio.src !== s.track) audio.src = s.track;
      try { audio.currentTime = lt; } catch (_) { /* ниже дожмём после метаданных */ }
      if (lt > 0 && audio.readyState < 1) {
        audio.addEventListener('loadedmetadata', function once() {
          audio.removeEventListener('loadedmetadata', once);
          try { audio.currentTime = lt; } catch (_) { /* no-op */ }
        });
      }
      if (playing) audio.play().catch(() => {});
    } else if (s.ownSound && stageVideo) {
      try { stageVideo.currentTime = lt; } catch (_) { /* no-op */ }
      if (playing) {
        stageVideo.play().catch(() => {
          stageVideo.muted = true;                    // iOS: без жеста звук нельзя — играем немым
          stageVideo.play().catch(() => {});
        });
      }
    } else {
      silentBase = lt;
      silentFrom = performance.now();
    }
  };

  const next = () => {
    if (seg + 1 >= segments.length) { finish(); return; }
    seg++;
    arm(0);
  };

  /* ---------- прослушивание для статистики ---------- */
  // Считаем РЕАЛЬНОЕ продвижение таймлайна: зависшая дорожка или отклонённый
  // play() время не наматывают. Скачок seek ограничен капом за тик.
  let playedMs = 0, lastG = 0, listenSent = false;
  const countListen = () => {
    if (listenSent || !albumId) return;
    if (playedMs >= LISTEN_AT_MS) {
      listenSent = true;
      sb.rpc('stat_listen', { p_album: albumId, p_country: country(), p_lang: lang() })
        .then(() => {}, () => {});   // supabase-js ленив: без then запрос не уйдёт
    }
  };

  /* ---------- панель управления ---------- */
  const fill = el('i');
  const bar = el('div', { class: 'narr-show-bar' }, fill);
  const timeCur = el('span', { class: 'narr-show-time', text: fmtDur(0) });
  const timeTot = el('span', { class: 'narr-show-time', text: fmtDur(totalDur) });

  const ticksAt = () => cueTicks || starts.slice(1);
  const placeTicks = () => {
    bar.querySelectorAll('b').forEach(b => b.remove());
    if (!(totalDur > 0)) return;
    ticksAt().forEach(at => {
      const b = el('b');
      b.style.left = `${Math.min(100, (at / totalDur) * 100)}%`;
      bar.appendChild(b);
    });
  };
  placeTicks();

  // Пересчёт после уточнения длительности сегмента по метаданным.
  const recompute = () => {
    starts = segStarts(segments);
    totalDur = starts[starts.length - 1] + segments[segments.length - 1].dur;
    timeTot.textContent = fmtDur(totalDur);
    placeTicks();
  };

  const pp = el('button', { class: 'narr-show-pp', 'aria-label': t('narr_listen') });
  const paintPP = () => {
    clear(pp);
    if (!playing || ended) pp.appendChild(playTriangle(16));
    else {
      const s = el('span');
      s.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" style="display:block"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
      pp.appendChild(s.firstElementChild);
    }
  };

  const pause = () => {
    if (!playing) return;
    silentBase = localTime();               // тишина: зафиксировать накопленное
    playing = false;
    audio.pause();
    stageVideo?.pause?.();
    paintPP();
  };
  const resume = () => {
    if (playing) return;
    if (ended) { ended = false; seg = 0; shownKey = null; playing = true; arm(0); paintPP(); return; }
    playing = true;
    silentFrom = performance.now();
    const s = segments[seg];
    if (s.track) audio.play().catch(() => {});
    else if (s.ownSound && stageVideo) stageVideo.play().catch(() => { stageVideo.muted = true; stageVideo.play().catch(() => {}); });
    paintPP();
  };
  pp.onclick = () => { playing ? pause() : resume(); };

  const seek = (gt) => {
    if (!(totalDur > 0)) return;
    const target = Math.max(0, Math.min(totalDur - 0.01, gt));
    let j = 0;
    for (let k = 0; k < segments.length; k++) if (starts[k] <= target) j = k;
    const wasPlaying = playing;
    ended = false;
    seg = j;
    shownKey = null;
    arm(target - starts[j]);
    if (!wasPlaying) drawFrame(seg, target - starts[j]);
    lastG = globalTime();
    paintPP();
    paint();
  };
  bar.onclick = (e) => {
    const r = bar.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * totalDur);
  };

  const finish = () => {
    ended = true;
    playing = false;
    audio.pause();
    stageVideo?.pause?.();
    paintPP();
  };

  const paint = () => {
    if (!(totalDur > 0)) return;
    const gt = Math.min(globalTime(), totalDur);
    fill.style.width = `${Math.min(100, (gt / totalDur) * 100)}%`;
    timeCur.textContent = fmtDur(gt);
    drawFrame(seg, localTime());
  };

  /* ---------- часы плеера ---------- */
  // Один интервал ведёт всё: кадры, полосу, границы сегментов и счёт
  // прослушивания. 100 мс достаточно и для галерей, и для меток рассказа.
  const timer = setInterval(() => {
    if (!playing || ended) { lastG = globalTime(); return; }
    const g = globalTime();
    if (g > lastG) playedMs += Math.min((g - lastG) * 1000, 500);
    lastG = g;
    countListen();

    const s = segments[seg];
    const lt = localTime();
    // конец сегмента: у дорожки чуть раньше, чтобы не ждать зависший ended;
    // сегмент с недотянутой длительностью (durGuess) закрывает только onended
    if (!s.durGuess && lt >= s.dur - 0.05) { next(); paint(); return; }
    paint();
  }, 100);
  audio.onended = () => { if (playing && segments[seg]?.track) { next(); paint(); } };

  /* ---------- оверлей ---------- */
  const overlay = el('div', { class: 'narr-show' },
    el('button', { class: 'narr-show-x', 'aria-label': t('cancel'), onclick: () => close(), text: '✕' }),
    stage,
    el('div', { class: 'narr-show-ctl' }, pp, timeCur, bar, timeTot));

  function key(e) {
    if (e.key === 'Escape') close();
    if (e.key === ' ') { e.preventDefault(); playing ? pause() : resume(); }
  }
  function close() {
    clearInterval(timer);
    playing = false;
    audio.pause();
    audio.onended = null;
    stageVideo?.pause?.();
    document.removeEventListener('keydown', key);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    overlay.remove();
  }

  document.addEventListener('keydown', key);
  document.body.appendChild(overlay);
  if (overlay.requestFullscreen) overlay.requestFullscreen().catch(() => {});

  // iOS: разблокировать <audio> первым жестом, даже если история начинается
  // с тишины — иначе play() следующих дорожек будет отклонён без жеста.
  const firstTrack = segments.find(s => s.track);
  if (firstTrack && !segments[0].track) {
    audio.src = firstTrack.track;
    audio.play().then(() => { if (!segments[seg]?.track) audio.pause(); }).catch(() => {});
  }

  playing = true;
  arm(0);
  paintPP();
  paint();
}
