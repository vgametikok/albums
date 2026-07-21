// Перекодирование видео в MP4/H.264 средствами браузера (WebCodecs).
//
// Зачем: ролики с телефонов приходят в .mov и разных кодеках, и у части зрителей
// не открываются. Приводим к MP4 + H.264/AAC — он играет везде.
//
// Почему именно так: первая версия снимала кадры с проигрывающегося <video> через
// MediaStreamTrackProcessor. Это оказалось негодным — в скрытой вкладке браузер
// останавливает воспроизведение, и перекодирование зависало бы навсегда у любого,
// кто переключит вкладку во время загрузки. Здесь контейнер разбирается напрямую
// (mp4box), кадры идут через VideoDecoder → VideoEncoder, скорость ограничена
// только железом и от видимости вкладки не зависит.
//
// Звук: decodeAudioData даёт весь PCM разом, дальше AudioEncoder в AAC.
// Разбираем только ISOBMFF (.mp4/.m4v/.mov). Прочее вернёт null — вызывающий
// код тогда грузит файл как есть.

const MP4BOX_URL = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm';
const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/+esm';
const MAX_EDGE = 1920;
const KEYFRAME_EVERY = 60;

let _mp4box = null, _muxer = null;
const mp4boxLib = () => (_mp4box ||= import(MP4BOX_URL));
const muxerLib = () => (_muxer ||= import(MUXER_URL));

// Уступить очередь задач, не попав под троттлинг. setTimeout в фоновой вкладке
// зажимается до одного раза в секунду — на нём перекодирование встаёт намертво,
// стоит переключить вкладку. Сообщения MessageChannel этому не подвержены.
const _chan = new MessageChannel();
let _waiters = [];
_chan.port1.onmessage = () => { const w = _waiters; _waiters = []; w.forEach(r => r()); };
function nextTask() {
  return new Promise(r => { _waiters.push(r); _chan.port2.postMessage(0); });
}

export function canTranscode() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
}

function isIsobmff(file) {
  const n = (file.name || '').toLowerCase();
  const t = (file.type || '').toLowerCase();
  return t === 'video/mp4' || t === 'video/quicktime' || /\.(mp4|m4v|mov)$/.test(n);
}

/**
 * MP4 с H.264 в пределах 1080p уже играет везде — такой файл не трогаем.
 * Но H.264 крупнее 1080p (например 4K) пережимаем: иначе он лёг бы в хранилище
 * в исходном разрешении и «видео ≤1080» по факту не соблюдалось бы.
 */
export async function needsTranscode(file) {
  const t = (file.type || '').toLowerCase();
  const n = (file.name || '').toLowerCase();
  const isMp4 = t === 'video/mp4' || /\.mp4$/.test(n);
  if (!isMp4) return true;
  try {
    const probe = await probeContainer(file);
    const v = probe?.video;
    if (!(v?.codec || '').startsWith('avc1')) return true;   // не H.264 — приводим к нему
    const w = v.track_width || v.video?.width || 0;
    const h = v.track_height || v.video?.height || 0;
    return Math.max(w, h) > MAX_EDGE;                         // крупнее 1080p — ужимаем
  } catch (_) {
    return true;
  }
}

/* ---------------- разбор контейнера ---------------- */

async function probeContainer(file) {
  const MP4Box = (await mp4boxLib()).default || (await mp4boxLib());
  const mp4 = MP4Box.createFile();
  const buf = await file.arrayBuffer();
  buf.fileStart = 0;

  return new Promise((resolve, reject) => {
    mp4.onError = (e) => reject(new Error('Не удалось разобрать контейнер: ' + e));
    mp4.onReady = (info) => {
      const vt = (info.videoTracks || [])[0];
      resolve({ mp4, MP4Box, info, video: vt, buf });
    };
    try {
      mp4.appendBuffer(buf);      // onReady срабатывает здесь же, если контейнер целый
      mp4.flush();
      nextTask().then(() => reject(new Error('Контейнер не читается')));
    } catch (e) { reject(e); }
  });
}

/** avcC/hvcC описание кодека — VideoDecoder без него не сконфигурируется. */
function codecDescription(MP4Box, mp4, trackId) {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const s = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      box.write(s);
      return new Uint8Array(s.buffer, 8);      // без заголовка бокса
    }
  }
  return null;
}

/** Поворот из матрицы трека: телефоны пишут кадр как есть плюс метку поворота. */
function rotationOf(track) {
  const m = track.matrix;
  if (!m) return 0;
  const U = 65536;
  const a = m[0] / U, b = m[1] / U, c = m[3] / U, d = m[4] / U;
  if (Math.abs(a) > 0.9 && d > 0.9) return 0;
  if (b > 0.9 && Math.abs(c) > 0.9) return 90;
  if (a < -0.9 && d < -0.9) return 180;
  if (b < -0.9 && c > 0.9) return 270;
  return 0;
}

function evenFit(w, h) {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const r2 = (n) => Math.max(2, Math.round(n * scale / 2) * 2);   // H.264 требует чётные стороны
  return { width: r2(w), height: r2(h) };
}

async function pickCodec(width, height, accel) {
  for (const codec of ['avc1.4d0028', 'avc1.42001f', 'avc1.42e01e']) {
    try {
      const cfg = { codec, width, height, bitrate: 2e6, framerate: 30 };
      if (accel) cfg.hardwareAcceleration = accel;
      const s = await VideoEncoder.isConfigSupported(cfg);
      if (s.supported) return codec;
    } catch (_) { /* следующий */ }
  }
  return null;
}

/** Кодировщик перестал отдавать результат — повод перезапуститься на программном. */
class Stalled extends Error {}

/**
 * Ждём, пока очередь рассосётся. Если за STALL_MS ни одного нового результата —
 * считаем кодировщик зависшим. Аппаратный H.264 на части машин и драйверов
 * встаёт через несколько кадров, и без этого загрузка висла бы вечно.
 */
async function drain(isBusy, outputs) {
  const STALL_MS = 6000;
  let seen = outputs();
  let mark = Date.now();
  while (isBusy()) {
    await nextTask();
    const now = outputs();
    if (now !== seen) { seen = now; mark = Date.now(); }
    else if (Date.now() - mark > STALL_MS) throw new Stalled('кодировщик перестал отвечать');
  }
}

/* ---------------- звук ---------------- */

async function decodeAudio(file) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    ctx.close();
    if (!buf || !buf.length) return null;
    const channels = Math.min(2, buf.numberOfChannels);
    const cfg = { codec: 'mp4a.40.2', sampleRate: buf.sampleRate, numberOfChannels: channels, bitrate: 128000 };
    const sup = await AudioEncoder.isConfigSupported(cfg);
    if (!sup.supported) return null;
    return { buf, channels, cfg };
  } catch (_) {
    return null;                      // немой ролик или дорожку не прочитать
  }
}

async function encodeAudio(audio, muxer) {
  const { buf, channels, cfg } = audio;
  const enc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: () => {},
  });
  enc.configure(cfg);

  const CHUNK = 4096;
  const planes = [];
  for (let c = 0; c < channels; c++) planes.push(buf.getChannelData(c));

  for (let off = 0; off < buf.length; off += CHUNK) {
    const n = Math.min(CHUNK, buf.length - off);
    const data = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) data.set(planes[c].subarray(off, off + n), c * n);
    const ad = new AudioData({
      format: 'f32-planar', sampleRate: buf.sampleRate, numberOfFrames: n,
      numberOfChannels: channels, timestamp: Math.round((off / buf.sampleRate) * 1e6), data,
    });
    enc.encode(ad);
    ad.close();
    if (enc.encodeQueueSize > 16) await nextTask();
  }
  await enc.flush();
  enc.close();
}

/* ---------------- постер ---------------- */

/**
 * Кадр-постер без воспроизведения: демультиплексируем и декодируем один первый
 * ключевой кадр. Прежний способ (перемотать <video> и снять кадр канвасом) на
 * телефонах молча не срабатывает — браузер не отдаёт кадр, пока ролик не играл,
 * а автовоспроизведение в фоне запрещено. Из-за этого у всех загруженных с
 * телефона видео постер отсутствовал.
 */
export async function posterFromVideo(file, maxEdge = 640) {
  if (typeof VideoDecoder === 'undefined' || !isIsobmff(file)) return null;
  let mp4, MP4Box, vtrack;
  try {
    ({ mp4, MP4Box, video: vtrack } = await probeContainer(file));
  } catch (_) { return null; }
  if (!vtrack) return null;

  const srcW = vtrack.track_width || vtrack.video?.width;
  const srcH = vtrack.track_height || vtrack.video?.height;
  if (!srcW || !srcH) return null;

  const description = codecDescription(MP4Box, mp4, vtrack.id);
  const cfg = { codec: vtrack.codec, codedWidth: srcW, codedHeight: srcH, ...(description ? { description } : {}) };
  try {
    const sup = await VideoDecoder.isConfigSupported(cfg);
    if (!sup.supported) return null;
  } catch (_) { return null; }

  const rotation = rotationOf(vtrack);
  const upW = rotation % 180 === 0 ? srcW : srcH;
  const upH = rotation % 180 === 0 ? srcH : srcW;
  const scale = Math.min(1, maxEdge / Math.max(upW, upH));
  const w = Math.max(1, Math.round(upW * scale));
  const h = Math.max(1, Math.round(upH * scale));

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');

    const decoder = new VideoDecoder({
      output: async (frame) => {
        try {
          ctx.save();
          ctx.translate(w / 2, h / 2);
          ctx.rotate(rotation * Math.PI / 180);
          const dw = rotation % 180 === 0 ? w : h;
          const dh = rotation % 180 === 0 ? h : w;
          ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
          ctx.restore();
          frame.close();
          const type = await webpOk() ? 'image/webp' : 'image/jpeg';
          finish(await canvas.convertToBlob({ type, quality: 0.75 }));
        } catch (_) { finish(null); }
        try { decoder.close(); } catch (_) {}
      },
      error: () => finish(null),
    });

    try {
      decoder.configure(cfg);
      const acc = [];
      mp4.onSamples = (_i, _u, s) => { acc.push(...s); };
      mp4.setExtractionOptions(vtrack.id, null, { nbSamples: 1 });
      mp4.start();
      mp4.flush();
      const first = acc.find(s => s.is_sync) || acc[0];
      if (!first) { finish(null); return; }
      decoder.decode(new EncodedVideoChunk({
        type: 'key', timestamp: 0,
        duration: Math.round((first.duration / first.timescale) * 1e6),
        data: first.data,
      }));
      decoder.flush().catch(() => finish(null));
    } catch (_) { finish(null); }

    setTimeout(() => finish(null), 15000);
  });
}

let _webp = null;
async function webpOk() {
  if (_webp !== null) return _webp;
  try {
    const c = new OffscreenCanvas(1, 1);
    const b = await c.convertToBlob({ type: 'image/webp' });
    _webp = b.type === 'image/webp';
  } catch (_) { _webp = false; }
  return _webp;
}

/* ---------------- основной путь ---------------- */

/**
 * @returns {{blob:Blob,width:number,height:number,duration:number}|null}
 *          null — контейнер или кодек не по зубам, грузим оригинал как есть.
 */
export async function transcodeToMp4(file, onProgress) {
  if (!canTranscode() || !isIsobmff(file)) return null;
  try {
    return await runTranscode(file, onProgress, undefined);
  } catch (e) {
    if (e instanceof Stalled) {
      // аппаратный кодировщик встал — повторяем на программном, он медленнее, но надёжен
      return await runTranscode(file, onProgress, 'prefer-software');
    }
    throw e;
  }
}

async function runTranscode(file, onProgress, accel) {
  const { mp4, MP4Box, info, video: vtrack } = await probeContainer(file);
  if (!vtrack) return null;

  const rotation = rotationOf(vtrack);
  const srcW = vtrack.track_width || vtrack.video?.width;
  const srcH = vtrack.track_height || vtrack.video?.height;
  if (!srcW || !srcH) return null;

  // при повороте на 90/270 итоговый кадр «ложится» наоборот
  const upW = rotation % 180 === 0 ? srcW : srcH;
  const upH = rotation % 180 === 0 ? srcH : srcW;
  const { width, height } = evenFit(upW, upH);

  const codec = await pickCodec(width, height, accel);
  if (!codec) return null;

  const description = codecDescription(MP4Box, mp4, vtrack.id);
  const decCfg = {
    codec: vtrack.codec,
    codedWidth: srcW, codedHeight: srcH,
    ...(description ? { description } : {}),
  };
  try {
    const sup = await VideoDecoder.isConfigSupported(decCfg);
    if (!sup.supported) return null;          // например HEVC там, где его нет
  } catch (_) { return null; }

  const durationSec = vtrack.duration / (vtrack.timescale || 1);
  const audio = await decodeAudio(file);
  const { Muxer, ArrayBufferTarget } = await muxerLib();
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    ...(audio ? { audio: { codec: 'aac', sampleRate: audio.buf.sampleRate, numberOfChannels: audio.channels } } : {}),
    fastStart: 'in-memory',
  });

  const bitrate = Math.min(6e6, Math.max(8e5, Math.round(width * height * 30 * 0.08)));
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure({
    codec, width, height, bitrate, framerate: 30, avc: { format: 'avc' },
    ...(accel ? { hardwareAcceleration: accel } : {}),
  });

  // Поворот и масштаб делаем канвасом; если ни того ни другого не нужно — кадр идёт напрямую.
  const needCanvas = rotation !== 0 || width !== srcW || height !== srcH;
  const canvas = needCanvas ? new OffscreenCanvas(width, height) : null;
  const ctx = canvas ? canvas.getContext('2d') : null;

  let encoded = 0;
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        let out = frame;
        if (needCanvas) {
          ctx.save();
          ctx.translate(width / 2, height / 2);
          ctx.rotate(rotation * Math.PI / 180);
          const dw = rotation % 180 === 0 ? width : height;
          const dh = rotation % 180 === 0 ? height : width;
          ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
          ctx.restore();
          out = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration });
          frame.close();
        }
        encoder.encode(out, { keyFrame: encoded % KEYFRAME_EVERY === 0 });
        out.close();
        encoded++;
        if (onProgress && durationSec) {
          onProgress(Math.min(0.98, (out.timestamp / 1e6) / durationSec));
        }
      } catch (e) {
        failure = e;
        try { frame.close(); } catch (_) {}
      }
    },
    error: (e) => { failure = e; },
  });
  decoder.configure(decCfg);

  // ---- вытаскиваем сэмплы и кормим декодер ----
  const samples = await new Promise((resolve, reject) => {
    const acc = [];
    mp4.onSamples = (_id, _u, s) => { acc.push(...s); };
    mp4.onError = (e) => reject(new Error(String(e)));
    mp4.setExtractionOptions(vtrack.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
    mp4.start();
    mp4.flush();
    resolve(acc);
  });
  if (!samples.length) { try { decoder.close(); encoder.close(); } catch (_) {} return null; }

  const ts = (s) => Math.round((s.cts / s.timescale) * 1e6);
  const closeAll = () => {
    try { if (decoder.state !== 'closed') decoder.close(); } catch (_) {}
    try { if (encoder.state !== 'closed') encoder.close(); } catch (_) {}
  };

  try {
    for (const s of samples) {
      if (failure) break;
      decoder.decode(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: ts(s),
        duration: Math.round((s.duration / s.timescale) * 1e6),
        data: s.data,
      }));
      // держим очереди короткими: много кадров «в полёте» исчерпывает пул буферов
      await drain(
        () => decoder.decodeQueueSize > 8 || encoder.encodeQueueSize > 8,
        () => encoded,
      );
    }
    await decoder.flush();
    await drain(() => encoder.encodeQueueSize > 0, () => encoded);
    await encoder.flush();
  } catch (e) {
    closeAll();
    throw e;                       // Stalled поймает вызывающий и повторит на программном
  }

  closeAll();
  if (failure) throw failure;
  if (!encoded) return null;

  if (audio) await encodeAudio(audio, muxer);

  muxer.finalize();
  onProgress && onProgress(1);
  return {
    blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }),
    width, height,
    duration: durationSec || 0,
  };
}
