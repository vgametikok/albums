// Чтение даты съёмки из EXIF — без сторонних библиотек.
//
// Зачем: при сжатии в WebP мы перерисовываем картинку канвасом, и EXIF стирается
// целиком (это сделано намеренно — вместе с ним уходят GPS-координаты). Но дата
// съёмки нужна: по ней раскладываем альбом на главы по дням. Поэтому читаем её
// из ИСХОДНОГО файла до сжатия и сохраняем отдельным полем. Координаты по-прежнему
// не сохраняем нигде.
//
// Формат: в JPEG блок EXIF лежит в сегменте APP1, в HEIC — в отдельном элементе
// контейнера. И там и там payload начинается с сигнатуры "Exif\0\0", за которой
// идёт обычный TIFF-заголовок. Поэтому не разбираем контейнеры, а ищем сигнатуру
// в начале файла и дальше читаем TIFF — работает для обоих форматов.

const SIG = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];   // "Exif\0\0"
const SCAN_BYTES = 512 * 1024;

const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME = 0x0132;         // дата изменения (запасной вариант)
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;

function findExifStart(buf) {
  const limit = buf.length - SIG.length;
  for (let i = 0; i < limit; i++) {
    if (buf[i] !== SIG[0]) continue;
    let ok = true;
    for (let k = 1; k < SIG.length; k++) {
      if (buf[i + k] !== SIG[k]) { ok = false; break; }
    }
    if (ok) return i + SIG.length;    // начало TIFF-заголовка
  }
  return -1;
}

/** «2026:07:19 14:32:05» → Date. В EXIF нет часового пояса, считаем локальным. */
function parseExifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m.map(Number);
  if (!y || y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d, h, mi, sec);
  return isNaN(dt.getTime()) ? null : dt;
}

function readAscii(view, offset, count) {
  let s = '';
  for (let i = 0; i < count; i++) {
    const c = view.getUint8(offset + i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Обходит один IFD и возвращает найденные интересующие теги. */
function walkIfd(view, base, ifdOffset, le, want) {
  const out = {};
  if (ifdOffset <= 0 || base + ifdOffset + 2 > view.byteLength) return out;
  const count = view.getUint16(base + ifdOffset, le);
  if (count > 512) return out;                       // защита от мусора
  for (let i = 0; i < count; i++) {
    const e = base + ifdOffset + 2 + i * 12;
    if (e + 12 > view.byteLength) break;
    const tag = view.getUint16(e, le);
    if (!want.includes(tag)) continue;
    const type = view.getUint16(e + 2, le);
    const num = view.getUint32(e + 4, le);
    if (type === 4 || type === 3) {                  // LONG / SHORT — указатель
      out[tag] = type === 4 ? view.getUint32(e + 8, le) : view.getUint16(e + 8, le);
    } else if (type === 2) {                         // ASCII
      const off = num <= 4 ? e + 8 : base + view.getUint32(e + 8, le);
      if (off >= 0 && off + Math.min(num, 32) <= view.byteLength) {
        out[tag] = readAscii(view, off, Math.min(num, 32));
      }
    }
  }
  return out;
}

/** Дата съёмки из байтов файла или null. */
export function captureDateFromBytes(bytes) {
  const base = findExifStart(bytes);
  if (base < 0 || base + 8 > bytes.length) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bom = view.getUint16(base, false);
  if (bom !== 0x4949 && bom !== 0x4D4D) return null;
  const le = bom === 0x4949;
  if (view.getUint16(base + 2, le) !== 42) return null;

  const ifd0 = view.getUint32(base + 4, le);
  const top = walkIfd(view, base, ifd0, le, [TAG_EXIF_IFD, TAG_DATETIME]);

  if (top[TAG_EXIF_IFD]) {
    const sub = walkIfd(view, base, top[TAG_EXIF_IFD], le,
      [TAG_DATETIME_ORIGINAL, TAG_DATETIME_DIGITIZED]);
    const d = parseExifDate(sub[TAG_DATETIME_ORIGINAL]) || parseExifDate(sub[TAG_DATETIME_DIGITIZED]);
    if (d) return d;
  }
  return parseExifDate(top[TAG_DATETIME]);
}

/**
 * Дата съёмки файла. Если EXIF нет (скриншот, картинка из мессенджера, видео),
 * берём дату файла — она обычно совпадает с моментом съёмки на телефоне.
 * Возвращает ISO-строку или null.
 */
export async function readCaptureDate(file) {
  try {
    const head = new Uint8Array(await file.slice(0, SCAN_BYTES).arrayBuffer());
    const d = captureDateFromBytes(head);
    if (d) return d.toISOString();
  } catch (_) { /* ниже запасной вариант */ }

  const lm = Number(file?.lastModified);
  if (lm && isFinite(lm)) {
    const d = new Date(lm);
    // Явная чушь (эпоха, будущее) — лучше ничего, чем неверная дата.
    const year = d.getFullYear();
    if (year >= 1990 && d.getTime() <= Date.now() + 86400000) return d.toISOString();
  }
  return null;
}
