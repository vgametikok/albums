// Блочный редактор «Истории» в редакторе альбома (STORY-PLAN.md §6).
//
// Медиа-секция редактора превращается в список БЛОКОВ: кадр / галерея / текст,
// в едином порядке позиций (позиции раздаёт album_story_reorder). Здесь же:
//   - объединение кадров в галерею (чекбоксы -> одна кнопка) и разбор;
//   - голосовые к кадрам и галереям: ЗАЖАТЬ кнопку — запись с микрофона,
//     отпустить — предпрослушка -> сохранить; на десктопе можно файлом;
//   - текстовые блоки;
//   - переключатель источника истории (авто / рассказ / голосовые).
//
// Прежние возможности карточки (подпись, глава, приватность, обложка,
// удалить, ↑/↓) сохранены. Перетаскивание — HTML5 DnD на десктопе, кнопки
// работают везде.
import { sb } from './sb.js';
import { el, clear, icon, toast, t, signUrls, thumbEl, dur, modal } from './ui.js';
import { uploadMedia } from './upload.js';

const VOICE_MAX_SEC = 300;   // мягкий лимит голосовой — 5 минут
const VOICE_MIN_MS = 700;    // короче — считаем случайным нажатием

/**
 * ctx:
 *   ensureAlbum()            — вернуть id альбома (создав черновик при нужде)
 *   getState()               — { items, texts, galleries, chapters, album }
 *   busyInc() / busyDec()    — счётчик «в обработке» (блокирует публикацию)
 *   onCover(mediaId)         — обложка сменилась (редактор обновит своё)
 * Возвращает { draw } — перерисовать список блоков в host.
 */
export function createStoryEditor(host, ctx) {
  const selected = new Set();          // id кадров, отмеченных для галереи
  let dragIndex = null;                // индекс блока, который тащат
  let stopActiveRec = null;            // остановить идущую запись (одна на редактор)

  // Свернули страницу или ушли — микрофон не должен остаться включённым.
  // Слушатели ставятся ОДИН раз на редактор, а не на каждую кнопку.
  const stopRec = () => stopActiveRec?.();
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopRec(); });
  window.addEventListener('pagehide', stopRec);

  /* ------------------------------------------------------------ порядок */

  function buildBlocks() {
    const { items, texts } = ctx.getState();
    const entries = [
      ...items.map(it => ({ type: 'm', pos: it.position ?? 0, it })),
      ...texts.map(tx => ({ type: 'x', pos: tx.position ?? 0, tx })),
    ].sort((a, b) => (a.pos - b.pos) || (a.type === b.type ? 0 : a.type === 'm' ? -1 : 1));

    const blocks = [];
    for (const e of entries) {
      const last = blocks[blocks.length - 1];
      if (e.type === 'm' && e.it.gallery_id) {
        if (last?.type === 'g' && last.gid === e.it.gallery_id) last.members.push(e.it);
        else blocks.push({ type: 'g', gid: e.it.gallery_id, members: [e.it] });
      } else {
        blocks.push(e.type === 'm' ? { type: 'm', it: e.it } : { type: 'x', tx: e.tx });
      }
    }
    return blocks;
  }

  /**
   * Полный порядок -> позиции локально + одним вызовом в базу. Вызовы
   * СЕРИАЛИЗОВАНЫ: два быстрых клика по стрелкам не должны обгонять друг
   * друга по сети (HTTP/2 не гарантирует порядок), победить обязан последний.
   * Заодно тексты получают главу соседнего медиа-блока — показ раскладывает
   * историю по главам, и без этого текст уезжал бы в хвост альбома.
   */
  let orderChain = Promise.resolve();
  function saveOrder(blocks) {
    const run = async () => {
      const albumId = await ctx.ensureAlbum();
      const list = [];
      let p = 0;
      for (const b of blocks) {
        if (b.type === 'm') { b.it.position = p++; list.push({ t: 'm', id: b.it.id }); }
        else if (b.type === 'x') { b.tx.position = p++; list.push({ t: 'x', id: b.tx.id }); }
        else b.members.forEach(m => { m.position = p++; list.push({ t: 'm', id: m.id }); });
      }
      const r = await sb.rpc('album_story_reorder', { p_album: albumId, p_items: list });
      if (r.error) { toast(r.error.message); return; }

      // глава текста = глава предыдущего медиа-блока (тексту до первого
      // кадра достаётся глава первого кадра альбома)
      const firstChapter = (() => {
        for (const b of blocks) {
          if (b.type === 'm') return b.it.chapter_id ?? null;
          if (b.type === 'g') return b.members[0]?.chapter_id ?? null;
        }
        return null;
      })();
      let cur = firstChapter;
      for (const b of blocks) {
        if (b.type === 'm') cur = b.it.chapter_id ?? null;
        else if (b.type === 'g') cur = b.members[0]?.chapter_id ?? null;
        else if ((b.tx.chapter_id ?? null) !== cur) {
          const r2 = await sb.rpc('album_text_upsert', {
            p_id: b.tx.id, p_album: albumId, p_chapter: cur, p_body: b.tx.body });
          if (r2.error) { toast(r2.error.message); continue; }
          b.tx.chapter_id = cur;
        }
      }
    };
    orderChain = orderChain.then(run, run);
    return orderChain;
  }

  async function moveBlock(idx, dir) {
    const blocks = buildBlocks();
    const j = idx + dir;
    if (j < 0 || j >= blocks.length) return;
    const [b] = blocks.splice(idx, 1);
    blocks.splice(j, 0, b);
    await saveOrder(blocks);
    draw();
  }

  /* ------------------------------------------------------------ галереи */

  async function groupSelected() {
    const { items } = ctx.getState();
    const chosen = items.filter(i => selected.has(i.id)).sort((a, b) => a.position - b.position);
    if (chosen.length < 2) return;
    // порядок блоков считаем ДО перестановки позиций сервером: RPC сдвинет
    // позиции выбранных кадров, и группировка «по соседям» на устаревших
    // локальных позициях разорвала бы галерею из несоседних кадров
    const before = buildBlocks();
    const r = await sb.rpc('album_gallery_group', {
      p_album: await ctx.ensureAlbum(), p_am_ids: chosen.map(i => i.id) });
    if (r.error) { toast(r.error.message); return; }
    const gid = r.data?.id;
    const { items: its, galleries } = ctx.getState();
    its.forEach(i => { if (selected.has(i.id)) i.gallery_id = gid; });
    galleries.push({ id: gid, voice_media_id: null, voice: null });

    // новый порядок: галерея целиком встаёт на место первого выбранного кадра
    const blocks = [];
    let placed = false;
    for (const b of before) {
      if (b.type === 'm' && selected.has(b.it.id)) {
        if (!placed) { blocks.push({ type: 'g', gid, members: chosen }); placed = true; }
        continue;
      }
      blocks.push(b);
    }
    selected.clear();
    await saveOrder(blocks);
    draw();
    toast(t('gallery_created'));
  }

  async function ungroup(gid) {
    const r = await sb.rpc('album_gallery_ungroup', { p_gallery: gid });
    if (r.error) { toast(r.error.message); return; }
    const { items, galleries } = ctx.getState();
    items.forEach(i => { if (i.gallery_id === gid) i.gallery_id = null; });
    const gi = galleries.findIndex(g => g.id === gid);
    if (gi >= 0) galleries.splice(gi, 1);
    draw();
  }

  /* ------------------------------------------------------------ голосовые */

  /**
   * Кнопка записи: зажать — записать, отпустить — предпрослушка. Короткое
   * нажатие открывает окно с прослушиванием/загрузкой файла/удалением.
   * target: {kind:'item', it} | {kind:'gallery', g}
   */
  function voiceButton(target) {
    const voice = target.kind === 'item' ? target.it.voice : target.g.voice;
    const btn = el('button', {
      class: 'mini voice-btn' + (voice ? ' has-voice' : ''),
      title: t('voice_hold_hint'),
    }, icon('mic', 15, { sw: 2 }), voice ? dur(voice.duration_seconds) : t('voice_add'));

    let stream = null, recorder = null, chunks = [], held = false, startTs = 0, timer = null;

    const stopTracks = () => { stream?.getTracks().forEach(tr => tr.stop()); stream = null; };
    const resetBtn = () => {
      btn.classList.remove('rec-on');
      clear(btn).append(icon('mic', 15, { sw: 2 }),
        document.createTextNode(voiceOf(target) ? dur(voiceOf(target).duration_seconds) : t('voice_add')));
    };

    const beginRec = async (e) => {
      e.preventDefault();
      // второй палец / повторное нажатие: не перезаписывать живой stream,
      // иначе первый микрофонный поток остался бы включённым навсегда
      if (held || stream || (recorder && recorder.state === 'recording')) return;
      held = true;
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* no-op */ }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        openVoiceModal(target, null);   // запись недоступна — сразу окно с загрузкой файла
        held = false;
        return;
      }
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (_) { toast(t('narr_mic_error')); held = false; return; }
      if (!held) { stopTracks(); return; }   // отпустили, пока браузер спрашивал разрешение

      chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = ev => chunks.push(ev.data);
      recorder.onstop = () => {
        stopTracks();
        clearInterval(timer);
        stopActiveRec = null;
        resetBtn();
        const ms = Date.now() - startTs;
        // короткое нажатие — это не запись, а «открыть окно голосовой»
        if (ms < VOICE_MIN_MS) { openVoiceModal(target, null); return; }
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type });
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        openVoiceModal(target, new File([blob], `voice.${ext}`, { type }));
      };
      recorder.start();
      stopActiveRec = () => endRec();
      startTs = Date.now();
      btn.classList.add('rec-on');
      const tick = () => {
        const s = Math.floor((Date.now() - startTs) / 1000);
        clear(btn).append(icon('stop', 15, { sw: 2 }), document.createTextNode(dur(s)));
        if (s >= VOICE_MAX_SEC) endRec();
      };
      tick();
      timer = setInterval(tick, 500);
    };

    const endRec = () => {
      held = false;
      if (recorder && recorder.state === 'recording') recorder.stop();
      else { stopTracks(); clearInterval(timer); stopActiveRec = null; }
    };

    btn.addEventListener('pointerdown', beginRec);
    btn.addEventListener('pointerup', (e) => {
      e.preventDefault();
      // отпустили, пока браузер ещё спрашивал разрешение — просто окно голосовой
      if (!recorder || recorder.state !== 'recording') {
        if (held) { held = false; openVoiceModal(target, null); }
        return;
      }
      endRec();   // короткое нажатие onstop сам превратит в окно голосовой
    });
    btn.addEventListener('pointercancel', endRec);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());   // long-press на телефоне
    return btn;
  }

  const voiceOf = (target) => target.kind === 'item' ? target.it.voice : target.g.voice;

  /** Окно голосовой: предпрослушка свежей записи или управление существующей. */
  function openVoiceModal(target, freshFile) {
    modal((box, closeRaw) => {
      // blob-URL записей (до 5 минут аудио) освобождаем при замене и закрытии
      let blobUrl = null;
      const setBlob = (f) => {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrl = URL.createObjectURL(f);
        return blobUrl;
      };
      const close = () => { if (blobUrl) URL.revokeObjectURL(blobUrl); closeRaw(); };

      box.appendChild(el('h2', { text: target.kind === 'gallery' ? t('voice_of_gallery') : t('voice_of_item') }));
      const existing = voiceOf(target);
      const status = el('div', { class: 'muted', style: 'font-size:14px;margin:8px 0' });
      const audioEl = el('audio', { controls: 'controls', style: 'width:100%;margin:8px 0' });

      let file = freshFile;
      if (file) {
        audioEl.src = setBlob(file);
        status.textContent = t('voice_preview_hint');
      } else if (existing) {
        signUrls([existing.storage_path]).then(u => { if (u[existing.storage_path]) audioEl.src = u[existing.storage_path]; });
        status.textContent = t('voice_existing_hint');
      } else {
        audioEl.classList.add('hide');
        status.textContent = t('voice_rec_hint');
      }

      const fileInput = el('input', { type: 'file', accept: 'audio/*', class: 'hide',
        onchange: (e) => {
          const f = e.currentTarget.files[0];
          if (!f) return;
          file = f;
          audioEl.classList.remove('hide');
          audioEl.src = setBlob(f);
          status.textContent = t('voice_preview_hint');
        } });

      const save = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:12px' }, t('voice_save'));
      save.onclick = async () => {
        if (!file) { toast(t('voice_need_record')); return; }
        save.disabled = true;
        clear(save).appendChild(el('span', { class: 'spinner' }));
        ctx.busyInc();
        try {
          await ctx.ensureAlbum();
          const media = await uploadMedia(file, (stage) => { status.textContent = t('narr_uploading'); });
          const r = target.kind === 'gallery'
            ? await sb.rpc('album_gallery_voice_set', { p_gallery: target.g.id, p_media: media.id })
            : await sb.rpc('album_voice_set', { p_am: target.it.id, p_media: media.id });
          if (r.error) throw r.error;
          const v = { storage_path: media.storage_path, duration_seconds: media.duration_seconds };
          if (target.kind === 'gallery') { target.g.voice = v; target.g.voice_media_id = media.id; }
          else { target.it.voice = v; target.it.voice_media_id = media.id; }
          close();
          toast(t('voice_saved'));
          ctx.storyRefresh?.();
          draw();
        } catch (err) {
          toast(err.message || t('upload_failed'));
          save.disabled = false;
          clear(save).appendChild(document.createTextNode(t('voice_save')));
        } finally { ctx.busyDec(); }
      };

      box.append(status, audioEl,
        el('div', { class: 'rowx', style: 'margin-top:6px' },
          el('button', { class: 'btn btn-ghost btn-sm', onclick: () => fileInput.click() }, t('narr_upload')),
          fileInput),
        save);

      if (existing) {
        box.appendChild(el('button', {
          class: 'btn btn-ghost btn-sm', style: 'width:100%;margin-top:10px',
          onclick: async () => {
            const r = target.kind === 'gallery'
              ? await sb.rpc('album_gallery_voice_clear', { p_gallery: target.g.id })
              : await sb.rpc('album_voice_clear', { p_am: target.it.id });
            if (r.error) { toast(r.error.message); return; }
            if (target.kind === 'gallery') { target.g.voice = null; target.g.voice_media_id = null; }
            else { target.it.voice = null; target.it.voice_media_id = null; }
            close();
            toast(t('voice_deleted'));
            ctx.storyRefresh?.();
            draw();
          },
        }, t('voice_delete')));
      }
      box.appendChild(el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, t('cancel')));
    });
  }

  /* ------------------------------------------------------------ тексты */

  async function addText() {
    const albumId = await ctx.ensureAlbum();
    modal((box, close) => {
      box.appendChild(el('h2', { text: t('text_block') }));
      const ta = el('textarea', { class: 'textarea', maxlength: '4000', placeholder: t('text_ph'), style: 'min-height:120px' });
      const add = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:12px' }, t('add'));
      add.onclick = async () => {
        const body = ta.value.trim();
        if (!body) { toast(t('text_empty')); return; }
        add.disabled = true;
        // блок встаёт в хвост истории — значит и глава у него хвостовая,
        // иначе показ (раскладка по главам) унёс бы его в «прочее»
        const { items } = ctx.getState();
        const lastChapter = [...items].sort((a, b) => a.position - b.position).pop()?.chapter_id ?? null;
        const r = await sb.rpc('album_text_upsert', { p_id: null, p_album: albumId, p_chapter: lastChapter, p_body: body });
        if (r.error) { toast(r.error.message); add.disabled = false; return; }
        ctx.getState().texts.push(r.data);
        close();
        draw();
      };
      box.append(ta, add,
        el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, t('cancel')));
    });
  }

  /* ------------------------------------------------------------ карточки */

  function chapterSelect(current, onchange) {
    const { chapters } = ctx.getState();
    return el('select', { class: 'mini', style: 'min-width:150px', onchange },
      el('option', { value: '' }, t('no_chapter_opt')),
      ...chapters.map(c => el('option', {
        value: c.id, selected: current === c.id ? 'selected' : null,
      }, c.label || c.title || t('chapters'))));
  }

  function arrows(idx, total) {
    return [
      el('button', { class: 'mini', onclick: () => moveBlock(idx, -1), disabled: idx === 0 ? 'disabled' : null }, '↑'),
      el('button', { class: 'mini', onclick: () => moveBlock(idx, 1), disabled: idx === total - 1 ? 'disabled' : null }, '↓'),
    ];
  }

  function mediaCard(b, idx, total, urls) {
    const it = b.it;
    const m = it.media || {};
    const { album } = ctx.getState();

    const th = el('div', { class: 'mthumb', style: 'display:flex;align-items:center;justify-content:center;overflow:hidden' });
    if (m.kind === 'audio') {
      th.appendChild(el('div', { style: 'font-size:12px;font-weight:700;color:#A69D8E', text: dur(m.duration_seconds) || 'AUDIO' }));
    } else {
      const src = urls[m.thumb_path] || urls[m.storage_path];
      const node = thumbEl(m.thumb_path || m.storage_path, src, m.thumb_path ? null : m.kind);
      if (node) { node.style.width = '100%'; node.style.height = '100%'; node.style.objectFit = 'cover'; th.appendChild(node); }
    }

    const cap = el('input', {
      class: 'input', style: 'height:36px;padding:0 12px;font-size:14px;border-radius:10px',
      placeholder: m.kind === 'audio' ? t('voice_ph') : t('cap_ph'), maxlength: '500', value: it.caption || '',
      onchange: async (e) => {
        it.caption = e.currentTarget.value;
        await sb.from('album_media').update({ caption: it.caption }).eq('id', it.id);
      },
    });

    const row = el('div', { class: 'row' },
      chapterSelect(it.chapter_id, async (e) => {
        const v = e.currentTarget.value || null;
        it.chapter_id = v;
        await sb.from('album_media').update({ chapter_id: v }).eq('id', it.id);
        await saveOrder(buildBlocks());
        draw();
      }),
      ...arrows(idx, total),
      m.kind !== 'audio' ? voiceButton({ kind: 'item', it }) : null,
      m.kind === 'photo' ? el('button', {
        class: 'mini' + (album?.cover_media_id === m.id ? ' on' : ''),
        style: album?.cover_media_id === m.id ? 'border-color:var(--accent);color:var(--accent)' : null,
        onclick: async () => {
          await sb.from('albums').update({ cover_media_id: m.id }).eq('id', await ctx.ensureAlbum());
          ctx.onCover(m.id);
          draw();
          toast(t('changes_saved'));
        },
      }, album?.cover_media_id === m.id ? t('cover_set') : t('set_cover')) : null,
      el('button', {
        class: 'mini',
        style: it.is_private ? 'border-color:var(--accent);color:var(--accent)' : null,
        title: t('private_hint'),
        onclick: async (e) => {
          const nextV = !it.is_private;
          const { error } = await sb.from('album_media').update({ is_private: nextV }).eq('id', it.id);
          if (error) { toast(error.message); return; }
          it.is_private = nextV;
          draw();
          toast(nextV ? t('private_on') : t('private_off'));
        },
      }, it.is_private ? t('is_private') : t('make_private')),
      el('button', {
        class: 'mini danger', onclick: async () => {
          const { error } = await sb.from('album_media').delete().eq('id', it.id);
          if (error) { toast(error.message); return; }
          const { items } = ctx.getState();
          const i = items.findIndex(x => x.id === it.id);
          if (i >= 0) items.splice(i, 1);
          selected.delete(it.id);
          draw();
        },
      }, t('remove')));

    const check = m.kind !== 'audio' && !it.gallery_id
      ? el('label', { class: 'sb-check', title: t('gallery_check_hint') },
          el('input', {
            type: 'checkbox', checked: selected.has(it.id) ? 'checked' : null,
            onchange: (e) => {
              e.currentTarget.checked ? selected.add(it.id) : selected.delete(it.id);
              drawBar();
            },
          }))
      : null;

    return card(idx, el('div', { class: 'mitem' }, check, th, el('div', { class: 'grow' }, cap, row)));
  }

  function galleryCard(b, idx, total, urls) {
    const g = (ctx.getState().galleries || []).find(x => x.id === b.gid) || { id: b.gid, voice: null };
    const stack = el('div', { class: 'gal-stack' });
    b.members.slice(0, 3).forEach(it => {
      const m = it.media || {};
      const src = urls[m.thumb_path] || urls[m.storage_path];
      const node = thumbEl(m.thumb_path || m.storage_path, src, m.thumb_path ? null : m.kind);
      if (node) stack.appendChild(el('div', { class: 'gal-cell' }, node));
    });

    const row = el('div', { class: 'row' },
      chapterSelect(b.members[0]?.chapter_id, async (e) => {
        const v = e.currentTarget.value || null;
        for (const it of b.members) {
          it.chapter_id = v;
          await sb.from('album_media').update({ chapter_id: v }).eq('id', it.id);
        }
        await saveOrder(buildBlocks());
        draw();
      }),
      ...arrows(idx, total),
      voiceButton({ kind: 'gallery', g }),
      el('button', { class: 'mini', onclick: () => ungroup(b.gid) }, t('gallery_break')));

    return card(idx, el('div', { class: 'mitem gal-item' }, stack,
      el('div', { class: 'grow' },
        el('div', { style: 'font-size:14.5px;font-weight:600', text: t('gallery_n', { count: b.members.length }) }),
        row)));
  }

  function textCard(b, idx, total) {
    const tx = b.tx;
    const ta = el('textarea', {
      class: 'textarea', style: 'min-height:64px;font-size:15px', maxlength: '4000',
      onchange: async (e) => {
        const body = e.currentTarget.value.trim();
        if (!body) { toast(t('text_empty')); e.currentTarget.value = tx.body; return; }
        const r = await sb.rpc('album_text_upsert', {
          p_id: tx.id, p_album: await ctx.ensureAlbum(), p_chapter: tx.chapter_id, p_body: body });
        if (r.error) { toast(r.error.message); return; }
        tx.body = body;
      },
    }, tx.body || '');

    const row = el('div', { class: 'row' },
      chapterSelect(tx.chapter_id, async (e) => {
        const v = e.currentTarget.value || null;
        const r = await sb.rpc('album_text_upsert', {
          p_id: tx.id, p_album: await ctx.ensureAlbum(), p_chapter: v, p_body: tx.body });
        if (r.error) { toast(r.error.message); return; }
        tx.chapter_id = v;
        await saveOrder(buildBlocks());
        draw();
      }),
      ...arrows(idx, total),
      el('button', {
        class: 'mini danger', onclick: async () => {
          const r = await sb.rpc('album_text_delete', { p_id: tx.id });
          if (r.error) { toast(r.error.message); return; }
          const { texts } = ctx.getState();
          const i = texts.findIndex(x => x.id === tx.id);
          if (i >= 0) texts.splice(i, 1);
          draw();
        },
      }, t('delete')));

    return card(idx, el('div', { class: 'mitem text-item' },
      el('div', { class: 'mthumb', style: 'display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#A69D8E', text: 'TEXT' }),
      el('div', { class: 'grow' }, ta, row)));
  }

  /**
   * Обёртка блока: перетаскивание на десктопе. Тянется РУЧКА, а не вся
   * карточка — иначе dragstart перехватывал бы выделение текста в подписи.
   */
  function card(idx, inner) {
    const handle = el('span', { class: 'drag-handle', draggable: 'true', 'aria-hidden': 'true', text: '⋮⋮' });
    handle.addEventListener('dragstart', (e) => {
      dragIndex = idx;
      e.dataTransfer.effectAllowed = 'move';
    });
    inner.insertBefore(handle, inner.firstChild);
    const wrap = el('div', { class: 'sblock' }, inner);
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('drag-over'); });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drag-over'));
    wrap.addEventListener('drop', async (e) => {
      e.preventDefault();
      wrap.classList.remove('drag-over');
      if (dragIndex === null || dragIndex === idx) return;
      const blocks = buildBlocks();
      const [b] = blocks.splice(dragIndex, 1);
      blocks.splice(idx, 0, b);
      dragIndex = null;
      await saveOrder(blocks);
      draw();
    });
    return wrap;
  }

  /* ------------------------------------------------------------ панель выбора */

  let bar = null;
  function drawBar() {
    bar?.remove();
    bar = null;
    if (selected.size < 2) return;
    bar = el('div', { class: 'gal-bar' },
      el('span', { text: t('gallery_selected', { count: selected.size }) }),
      el('button', { class: 'btn btn-primary btn-sm', onclick: groupSelected }, t('gallery_make')),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => { selected.clear(); draw(); },
      }, t('cancel')));
    host.appendChild(bar);
  }

  /* ------------------------------------------------------------ отрисовка */

  async function draw() {
    clear(host);
    bar = null;
    const { items, texts } = ctx.getState();
    const addTextBtn = el('button', {
      class: 'btn btn-ghost btn-sm', style: 'margin-top:10px',
      onclick: addText,
    }, t('text_add'));

    if (!items.length && !texts.length) {
      // пустой альбом: подсказка + возможность начать историю с текста
      host.append(
        el('div', { class: 'muted', style: 'padding:14px 2px', text: t('no_media') }),
        addTextBtn);
      return;
    }
    const blocks = buildBlocks();
    const paths = items.flatMap(i => [i.media?.thumb_path || i.media?.storage_path]).filter(Boolean);
    const urls = await signUrls(paths);

    blocks.forEach((b, idx) => {
      if (b.type === 'm') host.appendChild(mediaCard(b, idx, blocks.length, urls));
      else if (b.type === 'g') host.appendChild(galleryCard(b, idx, blocks.length, urls));
      else host.appendChild(textCard(b, idx, blocks.length));
    });

    host.appendChild(addTextBtn);
    drawBar();
  }

  return { draw };
}

/* ================================================== настройки истории */

/**
 * Блок «История» в редакторе: сводка по голосовым, переключатель источника
 * (авто / единый рассказ / голосовые) и вход в редактор меток рассказа.
 */
export function storySettingsBox(ctx, openNarration) {
  const box = el('div', { class: 'section-head', style: 'margin:40px 0 16px' },
    el('h2', { text: t('story_section') }));

  const wrap = el('div', { class: 'side-card', style: 'margin-bottom:8px' });
  const summary = el('div', { class: 'muted', style: 'font-size:14px;line-height:1.5' });

  const sel = el('select', { class: 'select', style: 'height:40px;font-size:14.5px;margin-top:10px' },
    el('option', { value: 'auto' }, t('story_src_auto')),
    el('option', { value: 'voices' }, t('story_src_voices')),
    el('option', { value: 'narration' }, t('story_src_narration')));
  sel.onchange = async () => {
    const r = await sb.rpc('album_story_mode_set', { p_album: await ctx.ensureAlbum(), p_mode: sel.value });
    if (r.error) { toast(r.error.message); return; }
    const { album } = ctx.getState();
    if (album) album.story_mode = sel.value === 'auto' ? null : sel.value;
    toast(t('changes_saved'));
  };

  const refresh = () => {
    const { items, galleries, album } = ctx.getState();
    const voicedItems = items.filter(i => i.voice_media_id);
    const voicedGals = (galleries || []).filter(g => g.voice_media_id);
    const totalSec = voicedItems.reduce((s, i) => s + (Number(i.voice?.duration_seconds) || 0), 0)
      + voicedGals.reduce((s, g) => s + (Number(g.voice?.duration_seconds) || 0), 0);
    summary.textContent = t('story_summary', {
      count: voicedItems.length + voicedGals.length,
      dur: dur(totalSec) || '0:00',
    });
    sel.value = album?.story_mode || 'auto';
  };
  refresh();

  wrap.append(summary, sel,
    el('button', {
      class: 'btn btn-ghost btn-sm', style: 'width:100%;margin-top:12px',
      onclick: openNarration,
    }, icon('mic', 16, { sw: 2 }), t('narr_edit')),
    el('div', { class: 'muted', style: 'font-size:13px;margin-top:10px;line-height:1.4', text: t('story_hint') }));

  return { node: el('div', {}, box, wrap), refresh };
}
