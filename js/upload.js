// Загрузка медиа: сжатие/постер на клиенте → приватный бакет → строка в media.
import { sb, currentUser } from './sb.js';
import { LIMITS } from './config.js';

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/webm': 'weba', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
};

export function kindOf(file) {
  if (file.type.startsWith('image/')) return 'photo';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return null;
}

async function compress(file, max, quality) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
  return { blob, width: w, height: h };
}

async function videoMeta(file) {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.playsInline = true; v.src = url;
    await new Promise((res, rej) => {
      v.onloadeddata = res;
      v.onerror = () => rej(new Error('Cannot read video'));
      setTimeout(() => rej(new Error('Video timeout')), 15000);
    });
    const duration = isFinite(v.duration) ? v.duration : null;
    try {
      v.currentTime = Math.min(0.2, (v.duration || 1) / 4);
      await new Promise((res) => { v.onseeked = res; setTimeout(res, 3000); });
    } catch (_) { /* постер снимем с первого кадра */ }
    const w = v.videoWidth || 0, h = v.videoHeight || 0;
    const scale = Math.min(1, 640 / Math.max(w || 1, h || 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
    return { thumb: blob, width: w, height: h, duration };
  } finally { URL.revokeObjectURL(url); }
}

async function audioDuration(file) {
  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement('audio');
    a.preload = 'metadata'; a.src = url;
    await new Promise((res, rej) => {
      a.onloadedmetadata = res;
      a.onerror = () => rej(new Error('Cannot read audio'));
      setTimeout(res, 8000);
    });
    return isFinite(a.duration) ? a.duration : null;
  } catch (_) { return null; } finally { URL.revokeObjectURL(url); }
}

/** Загружает один файл и возвращает строку media. */
export async function uploadMedia(file) {
  const user = currentUser();
  if (!user) throw new Error('Sign in first');
  const kind = kindOf(file);
  if (!kind) throw new Error('Unsupported file type');
  if (file.size > LIMITS[kind]) {
    throw new Error(`${file.name}: too large (max ${Math.round(LIMITS[kind] / 1048576)} MB)`);
  }

  const id = crypto.randomUUID();
  let body = file, thumb = null, width = null, height = null, duration = null;

  if (kind === 'photo') {
    if (file.type === 'image/gif') {
      const t = await compress(file, 640, 0.8);
      thumb = t.blob; width = t.width; height = t.height;
    } else {
      const full = await compress(file, 2560, 0.85);
      body = full.blob; width = full.width; height = full.height;
      thumb = (await compress(file, 640, 0.8)).blob;
    }
  } else if (kind === 'video') {
    const m = await videoMeta(file);
    thumb = m.thumb; width = m.width; height = m.height; duration = m.duration;
  } else {
    duration = await audioDuration(file);
  }

  const ext = EXT[body.type] || EXT[file.type] || 'bin';
  const path = `${user.id}/${id}/orig.${ext}`;
  const up = await sb.storage.from('media').upload(path, body, {
    contentType: body.type || file.type, upsert: false,
  });
  if (up.error) throw up.error;

  let thumbPath = null;
  if (thumb) {
    thumbPath = `${user.id}/${id}/thumb.jpg`;
    const t = await sb.storage.from('media').upload(thumbPath, thumb, { contentType: 'image/jpeg', upsert: true });
    if (t.error) thumbPath = null;
  }

  const { data, error } = await sb.from('media').insert({
    id, owner_id: user.id, kind, storage_path: path, thumb_path: thumbPath,
    width, height, duration_seconds: duration, size_bytes: body.size,
  }).select().single();
  if (error) throw error;
  return data;
}

/** Аватар/баннер — публичный бакет, стабильный URL. */
export async function uploadAvatar(file, which = 'avatar') {
  const user = currentUser();
  if (!user) throw new Error('Sign in first');
  if (!file.type.startsWith('image/')) throw new Error('Images only');
  const { blob } = await compress(file, which === 'banner' ? 1920 : 512, 0.85);
  const path = `${user.id}/${which}.jpg`;
  const { error } = await sb.storage.from('avatars').upload(path, blob, {
    contentType: 'image/jpeg', upsert: true,
  });
  if (error) throw error;
  const { data } = sb.storage.from('avatars').getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}
