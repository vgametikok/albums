// Загрузка медиа: декод (включая HEIC) → WebP на клиенте → приватный бакет → строка в media.
//
// Политика (решено 2026-07-19):
//   фото  — длинная сторона ≤2560px, WebP q0.82 (JPEG-фолбэк), превью 640px;
//           апскейла нет — меньшее остаётся меньшим; оригинал не хранится (HD — на платном тарифе);
//           EXIF стирается при перекодировании, включая GPS — геометки не утекают;
//   HEIC  — конвертируется в браузере через WASM (libheif), статус «в обработке»;
//   GIF   — заливается как есть (анимация сохраняется), превью — первый кадр;
//   видео — пока как есть + постер; перекодирование в MP4 через WebCodecs — следующий шаг.
import { sb, currentUser } from './sb.js';
import { LIMITS } from './config.js';
import { canTranscode, needsTranscode, transcodeToMp4, posterFromVideo } from './transcode.js';
import { t } from './i18n.js';

const MAX_EDGE = 2560;
const THUMB_EDGE = 640;
const Q_FULL = 0.82;
const Q_THUMB = 0.75;

const EXT = {
  'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/webm': 'weba', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
};

/** Тип файла. HEIC часто приходит с пустым file.type — поэтому смотрим и на расширение. */
export function kindOf(file) {
  const mime = (file.type || '').toLowerCase();
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const n = (file.name || '').toLowerCase();
  if (/\.(heic|heif|jpe?g|png|webp|gif|bmp|avif)$/.test(n)) return 'photo';
  if (/\.(mp4|webm|mov|m4v)$/.test(n)) return 'video';
  if (/\.(mp3|m4a|aac|wav|ogg|opus|weba)$/.test(n)) return 'audio';
  return null;
}

export function isHeic(file) {
  const mime = (file.type || '').toLowerCase();
  if (mime.startsWith('image/heic') || mime.startsWith('image/heif')) return true;
  return /\.(heic|heif)$/i.test(file.name || '');
}

/* ---------------- кодирование ---------------- */

let _webp = null;
async function webpSupported() {
  if (_webp !== null) return _webp;
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const b = await new Promise(r => c.toBlob(r, 'image/webp', 0.8));
  _webp = !!b && b.type === 'image/webp';
  return _webp;
}

let _heic = null;
async function heicToJpeg(file) {
  if (!_heic) _heic = import('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/+esm');
  const mod = await _heic;
  const convert = mod.default || mod;
  const out = await convert({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  return Array.isArray(out) ? out[0] : out;
}

/** Декодирует файл в ImageBitmap с учётом EXIF-поворота (иначе фото с телефона лягут набок). */
async function decode(file, onStage) {
  let src = file;
  if (isHeic(file)) {
    onStage && onStage('converting');
    try {
      src = await heicToJpeg(file);
    } catch (e) {
      throw new Error(t('err_heic'));
    }
  }
  return createImageBitmap(src, { imageOrientation: 'from-image' });
}

/** Ужимает до maxEdge (никогда не увеличивает) и кодирует в WebP, если браузер умеет. */
async function encodeFrom(bmp, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const type = (await webpSupported()) ? 'image/webp' : 'image/jpeg';
  const blob = await new Promise(r => c.toBlob(r, type, quality));
  if (!blob) throw new Error(t('err_image_process'));
  return { blob, width: w, height: h };
}

async function videoMeta(file) {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.playsInline = true; v.src = url;
    await new Promise((res, rej) => {
      v.onloadeddata = res;
      v.onerror = () => rej(new Error(t('err_video_open')));
      setTimeout(() => rej(new Error(t('err_video_slow'))), 20000);
    });
    const duration = isFinite(v.duration) ? v.duration : null;
    try {
      v.currentTime = Math.min(0.2, (v.duration || 1) / 4);
      await new Promise((res) => { v.onseeked = res; setTimeout(res, 3000); });
    } catch (_) { /* постер снимем с первого кадра */ }
    const w = v.videoWidth || 0, h = v.videoHeight || 0;
    const scale = Math.min(1, THUMB_EDGE / Math.max(w || 1, h || 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const type = (await webpSupported()) ? 'image/webp' : 'image/jpeg';
    const thumb = await new Promise(r => c.toBlob(r, type, Q_THUMB));
    return { thumb, width: w, height: h, duration };
  } finally { URL.revokeObjectURL(url); }
}

async function audioDuration(file) {
  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement('audio');
    a.preload = 'metadata'; a.src = url;
    await new Promise((res, rej) => {
      a.onloadedmetadata = res;
      a.onerror = () => rej(new Error(t('err_audio')));
      setTimeout(res, 8000);
    });
    return isFinite(a.duration) ? a.duration : null;
  } catch (_) { return null; } finally { URL.revokeObjectURL(url); }
}

/* ---------------- основной путь ---------------- */

/**
 * Загружает один файл и возвращает строку media.
 * onStage('converting'|'processing'|'uploading') — для индикатора «в обработке».
 */
export async function uploadMedia(file, onStage) {
  const user = currentUser();
  if (!user) throw new Error(t('err_signin_first'));
  const kind = kindOf(file);
  if (!kind) throw new Error(t('err_unsupported', { name: file.name }));
  if (file.size > LIMITS[kind]) {
    throw new Error(t('err_too_large', { name: file.name, mb: Math.round(LIMITS[kind] / 1048576) }));
  }

  const id = crypto.randomUUID();
  let body = file, thumb = null, width = null, height = null, duration = null;

  if (kind === 'photo') {
    const animated = (file.type || '').toLowerCase() === 'image/gif';
    const bmp = await decode(file, onStage);
    onStage && onStage('processing');
    try {
      thumb = (await encodeFrom(bmp, THUMB_EDGE, Q_THUMB)).blob;
      if (animated) {
        body = file; width = bmp.width; height = bmp.height;   // анимацию не трогаем
      } else {
        const full = await encodeFrom(bmp, MAX_EDGE, Q_FULL);
        body = full.blob; width = full.width; height = full.height;
      }
    } finally { bmp.close?.(); }
  } else if (kind === 'video') {
    // Приводим к MP4/H.264 — .mov и прочие кодеки открываются не у всех.
    if (canTranscode() && await needsTranscode(file)) {
      onStage && onStage('transcoding', 0);
      try {
        const out = await transcodeToMp4(file, (p) => onStage && onStage('transcoding', p));
        if (out) {
          body = new File([out.blob], 'video.mp4', { type: 'video/mp4' });
          width = out.width; height = out.height; duration = out.duration;
        }
      } catch (_) { /* не вышло — грузим оригинал как есть */ }
    }
    onStage && onStage('processing');
    // Сначала надёжный путь: декодируем первый кадр без воспроизведения.
    // На телефоне снять кадр через <video>+canvas не выходит, поэтому он лишь запасной.
    try { thumb = await posterFromVideo(body); } catch (_) { /* ниже запасной путь */ }
    try {
      const m = await videoMeta(body);
      thumb = thumb || m.thumb;
      width = width || m.width; height = height || m.height; duration = duration || m.duration;
    } catch (_) {
      // Браузер не открывает этот кодек — грузим файл как есть, размеры возьмём из транскода.
    }
  } else {
    onStage && onStage('processing');
    duration = await audioDuration(file);
  }

  onStage && onStage('uploading');
  const ext = EXT[body.type] || EXT[file.type] || 'bin';
  const path = `${user.id}/${id}/orig.${ext}`;
  const up = await sb.storage.from('media').upload(path, body, {
    contentType: body.type || file.type, upsert: false,
  });
  if (up.error) throw up.error;

  let thumbPath = null;
  if (thumb) {
    thumbPath = `${user.id}/${id}/thumb.${EXT[thumb.type] || 'jpg'}`;
    const t = await sb.storage.from('media').upload(thumbPath, thumb, { contentType: thumb.type, upsert: true });
    if (t.error) thumbPath = null;
  }

  const { data, error } = await sb.from('media').insert({
    id, owner_id: user.id, kind, storage_path: path, thumb_path: thumbPath,
    width, height, duration_seconds: duration, size_bytes: body.size,
  }).select().single();
  if (error) throw error;
  return data;
}

/**
 * Дозаполнение постера для уже загруженного видео. Ролики, залитые до того, как
 * появился надёжный способ снять кадр, лежат без превью — восстанавливаем их,
 * когда владелец открывает редактор.
 */
export async function backfillPoster(media) {
  const user = currentUser();
  if (!user || !media || media.kind !== 'video' || media.thumb_path) return null;
  if (media.owner_id && media.owner_id !== user.id) return null;

  const { data: signed } = await sb.storage.from('media').createSignedUrl(media.storage_path, 300);
  if (!signed?.signedUrl) return null;

  let blob;
  try {
    const resp = await fetch(signed.signedUrl);
    if (!resp.ok) return null;
    const file = new File([await resp.blob()], 'v.mp4', { type: 'video/mp4' });
    blob = await posterFromVideo(file);
  } catch (_) { return null; }
  if (!blob) return null;

  const path = `${user.id}/${media.id}/thumb.${EXT[blob.type] || 'jpg'}`;
  const up = await sb.storage.from('media').upload(path, blob, { contentType: blob.type, upsert: true });
  if (up.error) return null;
  const { error } = await sb.from('media').update({ thumb_path: path }).eq('id', media.id);
  if (error) return null;
  media.thumb_path = path;
  return path;
}

/** Аватар/баннер — публичный бакет, стабильный URL. */
export async function uploadAvatar(file, which = 'avatar') {
  const user = currentUser();
  if (!user) throw new Error(t('err_signin_first'));
  if (kindOf(file) !== 'photo') throw new Error(t('err_images_only'));
  const bmp = await decode(file);
  let out;
  try {
    out = await encodeFrom(bmp, which === 'banner' ? 1920 : 512, 0.85);
  } finally { bmp.close?.(); }
  const path = `${user.id}/${which}.${EXT[out.blob.type] || 'jpg'}`;
  const { error } = await sb.storage.from('avatars').upload(path, out.blob, {
    contentType: out.blob.type, upsert: true,
  });
  if (error) throw error;
  const { data } = sb.storage.from('avatars').getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}
