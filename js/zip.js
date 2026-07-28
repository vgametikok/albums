// Сборка ZIP прямо в браузере, без зависимостей и без CDN.
//
// Метод — STORE, без сжатия. Фото и видео уже сжаты, дефлейт выиграл бы
// проценты за десятки секунд процессорного времени, а на свадебном альбоме
// в несколько гигабайт это минуты ожидания на пустом месте.
//
// Память. Файлы никогда не разворачиваются в массивы целиком: CRC32 считается
// потоком по кускам, а сами данные так и остаются Blob-ами, которые браузер
// держит на диске. Поэтому архив на 5 ГБ собирается в пределах десятков
// мегабайт оперативной памяти.
//
// ZIP64 включается по факту, для каждой записи отдельно: файл больше 4 ГиБ,
// смещение больше 4 ГиБ или больше 65534 записей. Без него архив со свадебным
// видео молча собрался бы битым.

const U32_MAX = 0xFFFFFFFF;

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

/** CRC32 блоба потоком: в памяти одновременно только один кусок. */
async function crc32(blob) {
  let c = 0xFFFFFFFF;
  const feed = (bytes) => {
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  };

  const stream = blob.stream?.();
  if (stream) {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(value);
    }
  } else {
    // Совсем старые браузеры: режем сами кусками по 4 МБ.
    const CHUNK = 4 << 20;
    for (let off = 0; off < blob.size; off += CHUNK) {
      feed(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()));
    }
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Время и дата в формате DOS — так их хранит ZIP с 1989 года. */
function dosStamp(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

const u64 = (view, off, n) => view.setBigUint64(off, BigInt(n), true);

/**
 * Сборщик архива.
 *
 *   const zip = createZip();
 *   await zip.add('photo.jpg', blob);
 *   const archive = zip.finish();     // Blob
 */
export function createZip() {
  const enc = new TextEncoder();
  const parts = [];      // Uint8Array | Blob — из них соберётся итоговый Blob
  const entries = [];
  let offset = 0;        // текущее смещение от начала архива
  const used = new Set();

  /** Имя, безопасное для файловой системы и уникальное внутри архива. */
  function uniqueName(name) {
    let base = String(name)
      .replace(/[\\:*?"<>|\u0000-\u001F]/g, '')
      .replace(/\/{2,}/g, '/')
      .replace(/(^\/|\/$)/g, '')
      .trim() || 'file';
    if (!used.has(base)) { used.add(base); return base; }

    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let i = 2; ; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!used.has(candidate)) { used.add(candidate); return candidate; }
    }
  }

  async function add(name, blob, when = new Date()) {
    const fileName = uniqueName(name);
    const nameBytes = enc.encode(fileName);
    const size = blob.size;
    const crc = await crc32(blob);
    const { time, date } = dosStamp(when);
    // В ЛОКАЛЬНОМ заголовке ZIP64 нужен только из-за размера файла. Смещение
    // записи хранится не здесь, а в центральном каталоге, и подменять из-за
    // него поля размеров нельзя: строгие распаковщики (в том числе штатный
    // windows-овский) считают такой заголовок битым.
    const bigSize = size >= U32_MAX;

    const extraLen = bigSize ? 20 : 0;
    const head = new Uint8Array(30 + nameBytes.length + extraLen);
    const v = new DataView(head.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, bigSize ? 45 : 20, true);
    v.setUint16(6, 0x0800, true);                       // имена в UTF-8
    v.setUint16(8, 0, true);                            // STORE
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, bigSize ? U32_MAX : size, true);
    v.setUint32(22, bigSize ? U32_MAX : size, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, extraLen, true);
    head.set(nameBytes, 30);
    if (bigSize) {
      const e = 30 + nameBytes.length;
      v.setUint16(e, 0x0001, true);
      v.setUint16(e + 2, 16, true);
      u64(v, e + 4, size);
      u64(v, e + 12, size);
    }

    entries.push({ nameBytes, crc, size, time, date, offset, bigSize });
    parts.push(head, blob);
    offset += head.length + size;
    return fileName;
  }

  function finish() {
    const cdStart = offset;
    let cdSize = 0;

    for (const e of entries) {
      // В центральном каталоге ZIP64 может понадобиться и там, где в локальном
      // заголовке он не был нужен: смещение записи хранится только здесь.
      // В extra-поле кладём РОВНО те величины, которые заменены на 0xFFFFFFFF,
      // и в порядке из спецификации: размер, сжатый размер, смещение.
      const bigOffset = e.offset >= U32_MAX;
      const payload = (e.bigSize ? 16 : 0) + (bigOffset ? 8 : 0);
      const extraLen = payload ? payload + 4 : 0;
      const rec = new Uint8Array(46 + e.nameBytes.length + extraLen);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 45, true);                         // кем создан
      v.setUint16(6, payload ? 45 : 20, true);          // минимальная версия
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, e.time, true);
      v.setUint16(14, e.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.bigSize ? U32_MAX : e.size, true);
      v.setUint32(24, e.bigSize ? U32_MAX : e.size, true);
      v.setUint16(28, e.nameBytes.length, true);
      v.setUint16(30, extraLen, true);
      v.setUint16(32, 0, true);                         // комментарий
      v.setUint16(34, 0, true);                         // диск
      v.setUint16(36, 0, true);                         // внутренние атрибуты
      v.setUint32(38, 0, true);                         // внешние атрибуты
      v.setUint32(42, bigOffset ? U32_MAX : e.offset, true);
      rec.set(e.nameBytes, 46);
      if (payload) {
        let x = 46 + e.nameBytes.length;
        v.setUint16(x, 0x0001, true);
        v.setUint16(x + 2, payload, true);
        x += 4;
        if (e.bigSize) { u64(v, x, e.size); u64(v, x + 8, e.size); x += 16; }
        if (bigOffset) u64(v, x, e.offset);
      }
      parts.push(rec);
      cdSize += rec.length;
    }

    const needZip64 = entries.length > 0xFFFE || cdStart >= U32_MAX || cdSize >= U32_MAX
      || entries.some(e => e.bigSize || e.offset >= U32_MAX);

    if (needZip64) {
      const z = new Uint8Array(56);
      const v = new DataView(z.buffer);
      v.setUint32(0, 0x06064b50, true);
      u64(v, 4, 44);                                    // размер записи после этого поля
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setUint32(16, 0, true);                         // номер диска
      v.setUint32(20, 0, true);                         // диск с началом каталога
      u64(v, 24, entries.length);
      u64(v, 32, entries.length);
      u64(v, 40, cdSize);
      u64(v, 48, cdStart);
      parts.push(z);

      const loc = new Uint8Array(20);
      const lv = new DataView(loc.buffer);
      lv.setUint32(0, 0x07064b50, true);
      lv.setUint32(4, 0, true);
      u64(lv, 8, cdStart + cdSize);
      lv.setUint32(16, 1, true);
      parts.push(loc);
    }

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, needZip64 ? 0xFFFF : entries.length, true);
    ev.setUint16(10, needZip64 ? 0xFFFF : entries.length, true);
    ev.setUint32(12, needZip64 ? U32_MAX : cdSize, true);
    ev.setUint32(16, needZip64 ? U32_MAX : cdStart, true);
    ev.setUint16(20, 0, true);
    parts.push(end);

    return new Blob(parts, { type: 'application/zip' });
  }

  return { add, finish, get count() { return entries.length; } };
}
