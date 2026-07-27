// Озвучка альбома: голосовой рассказ на весь альбом + метки «на секунде N
// показываем это медиа».
//
// Редактор (для автора) и плеер (для зрителя) в одном модуле, потому что делят
// логику расстановки и чтения меток. Запись с микрофона — основной сценарий,
// поэтому рассчитано в первую очередь на телефон.
import { sb } from './sb.js';
import { el, clear, icon, toast, t, signUrls, thumbEl, dur, modal, playTriangle } from './ui.js';
import { uploadMedia } from './upload.js';

/* ================================================================ РЕДАКТОР */

/**
 * @param albumId
 * @param mediaItems  [{am_id, id, kind, path, thumb, caption}] — визуальные медиа альбома по порядку
 */
export function openNarrationEditor(albumId, mediaItems) {
  const visual = mediaItems.filter(m => m.kind !== 'audio');
  let audioUrl = null, mediaId = null, duration = 0;
  let cues = [];              // [{album_media_id, at}]
  let recorder = null, chunks = [], recording = false;

  modal((box, close) => {
    box.style.maxWidth = '640px';
    box.appendChild(el('h2', { text: t('narr_title') }));
    box.appendChild(el('p', { text: t('narr_hint') }));

    const audioEl = el('audio', { controls: 'controls', style: 'width:100%;margin:8px 0' });
    const recRow = el('div', { class: 'rowx', style: 'margin-bottom:12px' });
    const cueHost = el('div', {});
    const status = el('div', { class: 'muted', style: 'font-size:14px;margin:8px 0' });

    /* ---- источник аудио: запись или файл ---- */
    const canRecord = typeof MediaRecorder !== 'undefined' && navigator.mediaDevices?.getUserMedia;
    const recBtn = el('button', { class: 'btn btn-ghost btn-sm', onclick: toggleRec }, icon('mic', 16, { sw: 2 }), t('narr_record'));
    const fileInput = el('input', { type: 'file', accept: 'audio/*', class: 'hide',
      onchange: (e) => { const f = e.currentTarget.files[0]; if (f) useAudioFile(f); } });
    const upBtn = el('button', { class: 'btn btn-ghost btn-sm', onclick: () => fileInput.click() }, t('narr_upload'));
    if (canRecord) recRow.appendChild(recBtn);
    recRow.append(upBtn, fileInput);

    async function toggleRec() {
      if (recording) { recorder.stop(); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = [];
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = e => chunks.push(e.data);
        recorder.onstop = async () => {
          stream.getTracks().forEach(tr => tr.stop());
          recording = false;
          recBtn.classList.remove('rec-on');
          clear(recBtn).append(icon('mic', 16, { sw: 2 }), document.createTextNode(t('narr_record')));
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          await useAudioFile(new File([blob], 'narration.webm', { type: blob.type }));
        };
        recorder.start();
        recording = true;
        recBtn.classList.add('rec-on');
        clear(recBtn).append(icon('stop', 16, { sw: 2 }), document.createTextNode(t('narr_stop')));
      } catch (_) { toast(t('narr_mic_error')); }
    }

    async function useAudioFile(file) {
      status.textContent = t('narr_uploading');
      try {
        const media = await uploadMedia(file);
        mediaId = media.id;
        duration = media.duration_seconds || 0;
        const u = await signUrls([media.storage_path]);
        audioUrl = u[media.storage_path];
        audioEl.src = audioUrl;
        await sb.rpc('narration_set', { p_album: albumId, p_media: mediaId, p_duration: duration });
        status.textContent = t('narr_ready');
        drawCues();
      } catch (err) { status.textContent = ''; toast(err.message || t('upload_failed')); }
    }

    /* ---- метки ---- */
    // «Поставить метку»: текущая секунда дорожки привязывается к выбранному медиа.
    function drawCues() {
      clear(cueHost);
      if (!mediaId) {
        cueHost.appendChild(el('div', { class: 'muted', style: 'padding:8px 0', text: t('narr_need_audio') }));
        return;
      }
      cueHost.appendChild(el('div', { class: 'label', style: 'margin:12px 0 8px', text: t('narr_cues') }));
      const grid = el('div', { class: 'narr-grid' });
      visual.forEach(m => {
        const cue = cues.find(c => c.album_media_id === m.am_id);
        const cell = el('div', { class: 'narr-cell' + (cue ? ' has-cue' : '') });
        const node = thumbEl(m.thumb || m.path, m._url, m.thumb ? null : m.kind);
        if (node) cell.appendChild(node);
        cell.appendChild(el('button', {
          class: 'narr-mark',
          onclick: () => {
            const at = Math.max(0, audioEl.currentTime || 0);
            cues = cues.filter(c => c.album_media_id !== m.am_id);
            cues.push({ album_media_id: m.am_id, at: Math.round(at * 10) / 10 });
            drawCues();
          },
        }, cue ? `${dur(cue.at)} ✎` : t('narr_set_here')));
        if (cue) {
          cell.appendChild(el('button', {
            class: 'narr-clear', 'aria-label': t('remove'),
            onclick: () => { cues = cues.filter(c => c.album_media_id !== m.am_id); drawCues(); },
          }, '×'));
        }
        grid.appendChild(cell);
      });
      cueHost.appendChild(grid);
    }

    const save = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:16px' }, t('save'));
    save.onclick = async () => {
      if (!mediaId) { toast(t('narr_need_audio')); return; }
      save.disabled = true;
      const r = await sb.rpc('narration_cues_set', {
        p_album: albumId,
        p_cues: cues.map(c => ({ album_media_id: c.album_media_id, at_seconds: c.at })),
      });
      save.disabled = false;
      if (r.error) { toast(r.error.message); return; }
      close();
      toast(t('narr_saved'));
    };

    const del = el('button', { class: 'btn btn-ghost btn-sm', style: 'width:100%;margin-top:10px',
      onclick: async () => {
        if (!confirm(t('narr_delete_confirm'))) return;
        await sb.rpc('narration_clear', { p_album: albumId });
        close(); toast(t('narr_deleted'));
      } }, t('narr_delete'));

    box.append(recRow, audioEl, status, cueHost, save, del,
      el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, t('cancel')));

    // подгружаем превью и существующую озвучку
    (async () => {
      const paths = visual.map(m => m.thumb || m.path);
      const urls = await signUrls(paths);
      visual.forEach(m => { m._url = urls[m.thumb] || urls[m.path]; });
      const { data } = await sb.rpc('narration_get', { p_album: albumId });
      if (data) {
        mediaId = data.media_id; duration = data.duration || 0;
        cues = (data.cues || []).map(c => ({ album_media_id: c.album_media_id, at: Number(c.at) }));
        const u = await signUrls([data.path]);
        audioUrl = u[data.path]; audioEl.src = audioUrl;
        status.textContent = t('narr_ready');
      }
      drawCues();
    })();
  }, { wide: true });
}

/* ================================================================ ПЛЕЕР */

/**
 * Плеер рассказа на странице альбома. Кнопка открывает полноэкранное
 * слайд-шоу; сам показ живёт в общем плеере историй (storyplayer.js) — тот же
 * оверлей играет и сборку из голосовых. Здесь остались только загрузка
 * narration_get и кнопка. API прежний.
 */
export function mountNarrationPlayer(host, albumId, mediaItems, urls) {
  (async () => {
    const { data } = await sb.rpc('narration_get', { p_album: albumId });
    if (!data || !data.cues?.length) return;

    const u = await signUrls([data.path]);
    const cues = (data.cues || []).map(c => ({ id: c.album_media_id, at: Number(c.at) }))
      .sort((a, b) => a.at - b.at);

    clear(host).append(el('div', {
      class: 'narr-player', style: 'cursor:pointer',
      onclick: async () => {
        const { openNarrationShow } = await import('./storyplayer.js');
        openNarrationShow({
          albumId,
          audioUrl: u[data.path], audioPath: data.path,
          duration: Number(data.duration) || 0,
          cues, mediaItems, urls,
        });
      },
    },
      el('button', { class: 'narr-play', 'aria-label': t('narr_listen') }, playTriangle(16)),
      el('div', { class: 'narr-info' },
        el('div', { class: 'narr-label', text: t('narr_listen') }),
        el('div', { class: 'muted', style: 'font-size:13.5px', text: dur(data.duration || 0) }))));
  })();
}
