// Печатная табличка с QR события: редактор (дизайн, ориентация, цвета, фото,
// тексты) с живым предпросмотром и печать сохранённой версии.
//
// Табличка рисуется в фиксированной системе координат «как на бумаге»:
// 194×262 мм (вертикально) или 262×190 мм (горизонтально) при 96 dpi. Этот
// прямоугольник влезает и в A4, и в Letter, поэтому печать одинакова на любой
// бумаге, а предпросмотр — тот же DOM, только уменьшенный transform'ом.
//
// QR всегда тёмный на белой карточке с полем 4 модуля и коррекцией H — какие
// бы цвета ни выбрал хозяин, код остаётся контрастным и читается.
import { sb } from './sb.js';
import { el, clear, toast, t, modal, signUrls } from './ui.js';
import { qrSvg } from './qr.js';
import { uploadMedia } from './upload.js';

const MM = 96 / 25.4;
// Табличка — ровно лист A4 в CSS-пикселях: фон дизайна печатается в край
// (@page margin:0), текст и код держатся внутри безопасных полей .qs-inner.
const SIZE = { v: [794, 1123], h: [1123, 794] };
const LS_KEY = (id) => `qrSign:${id}`;

/** Дизайны: свои цвета по умолчанию, шрифт заголовка и украшения. */
export const DESIGNS = {
  plain:  { acc: '#C9A227', bg: '#FFFFFF', ink: '#141414', font: 'inter' },
  flowers:{ acc: '#D98C9F', bg: '#FFF8F5', ink: '#4A3A3C', font: 'greatvibes' },
  moon:   { acc: '#E9C46A', bg: '#13224A', ink: '#F6F1E4', font: 'cormorant' },
  splash: { acc: '#8E44AD', bg: '#FCF9FF', ink: '#2E1A47', font: 'montserrat' },
  neon:   { acc: '#FF3EA5', bg: '#0B0B14', ink: '#FFFFFF', font: 'unbounded' },
  gold:   { acc: '#B08D2E', bg: '#FBF7EE', ink: '#3A2F1E', font: 'playfair' },
  water:  { acc: '#7FA8C9', bg: '#FFFDF9', ink: '#3D4A5C', font: 'cormorant' },
  dark:   { acc: '#C9A227', bg: '#1C1B19', ink: '#F5F2EA', font: 'inter' },
};
const DESIGN_KEYS = Object.keys(DESIGNS);

/**
 * Шрифты таблички — свой набор на каждую письменность (group):
 *   latin — латиница + кириллица + вьетнамский (все шрифты списка их умеют);
 *   ko / sc / ja — родные шрифты для корейского, китайского (упрощ.) и японского.
 * Набор выбирается по письменности текста таблички, иначе по языку сайта.
 * Всё — Google Fonts (CSP страницы их пускает); CSS разбит по unicode-range,
 * поэтому скачиваются только файлы под реально набранные символы.
 * cat — характер (для замены при смене набора), k — поправка кегля,
 * w/w2 — вес заголовка и остальных строк.
 */
const F = (group, fam, q, cat, w = 400, w2 = 400, k = 1) => ({ group, fam, q, cat, w, w2, k });
export const FONTS = {
  // latin / кириллица / вьетнамский
  cormorant:  F('latin', 'Cormorant Garamond', 'Cormorant+Garamond:wght@500;700', 'serif', 700, 500, 1.12),
  playfair:   F('latin', 'Playfair Display', 'Playfair+Display:wght@400;700', 'serif', 700, 400, 0.95),
  prata:      F('latin', 'Prata', 'Prata', 'serif', 400, 400, 0.92),
  greatvibes: F('latin', 'Great Vibes', 'Great+Vibes', 'script', 400, 400, 1.3),
  pacifico:   F('latin', 'Pacifico', 'Pacifico', 'script', 400, 400, 0.9),
  amatic:     F('latin', 'Amatic SC', 'Amatic+SC:wght@400;700', 'script', 700, 700, 1.3),
  montserrat: F('latin', 'Montserrat', 'Montserrat:wght@500;700', 'sans', 700, 500, 0.95),
  inter:      F('latin', 'Inter', 'Inter:wght@500;800', 'sans', 800, 500, 1),
  unbounded:  F('latin', 'Unbounded', 'Unbounded:wght@400;700', 'display', 700, 400, 0.82),
  comfortaa:  F('latin', 'Comfortaa', 'Comfortaa:wght@500;700', 'rounded', 700, 500, 0.95),
  // 한국어
  kr_serif:   F('ko', 'Noto Serif KR', 'Noto+Serif+KR:wght@400;700', 'serif', 700, 400),
  kr_sans:    F('ko', 'Noto Sans KR', 'Noto+Sans+KR:wght@400;700', 'sans', 700, 400),
  kr_myeongjo:F('ko', 'Nanum Myeongjo', 'Nanum+Myeongjo:wght@400;800', 'serif', 800, 400),
  kr_gothic:  F('ko', 'Nanum Gothic', 'Nanum+Gothic:wght@400;800', 'sans', 800, 400),
  kr_batang:  F('ko', 'Gowun Batang', 'Gowun+Batang:wght@400;700', 'serif', 700, 400),
  kr_dodum:   F('ko', 'Gowun Dodum', 'Gowun+Dodum', 'rounded'),
  kr_pen:     F('ko', 'Nanum Pen Script', 'Nanum+Pen+Script', 'script', 400, 400, 1.3),
  kr_gaegu:   F('ko', 'Gaegu', 'Gaegu:wght@400;700', 'script', 700, 400, 1.15),
  kr_jua:     F('ko', 'Jua', 'Jua', 'rounded'),
  kr_blackhan:F('ko', 'Black Han Sans', 'Black+Han+Sans', 'display'),
  kr_dohyeon: F('ko', 'Do Hyeon', 'Do+Hyeon', 'display'),
  // 简体中文
  sc_serif:   F('sc', 'Noto Serif SC', 'Noto+Serif+SC:wght@400;700', 'serif', 700, 400),
  sc_sans:    F('sc', 'Noto Sans SC', 'Noto+Sans+SC:wght@400;700', 'sans', 700, 400),
  sc_xiaowei: F('sc', 'ZCOOL XiaoWei', 'ZCOOL+XiaoWei', 'serif'),
  sc_mashan:  F('sc', 'Ma Shan Zheng', 'Ma+Shan+Zheng', 'script', 400, 400, 1.1),
  sc_longcang:F('sc', 'Long Cang', 'Long+Cang', 'script', 400, 400, 1.15),
  sc_zhimang: F('sc', 'Zhi Mang Xing', 'Zhi+Mang+Xing', 'script', 400, 400, 1.15),
  sc_liujian: F('sc', 'Liu Jian Mao Cao', 'Liu+Jian+Mao+Cao', 'script', 400, 400, 1.15),
  sc_kuaile:  F('sc', 'ZCOOL KuaiLe', 'ZCOOL+KuaiLe', 'rounded'),
  sc_qingke:  F('sc', 'ZCOOL QingKe HuangYou', 'ZCOOL+QingKe+HuangYou', 'display'),
  // 日本語
  jp_serif:   F('ja', 'Noto Serif JP', 'Noto+Serif+JP:wght@400;700', 'serif', 700, 400),
  jp_sans:    F('ja', 'Noto Sans JP', 'Noto+Sans+JP:wght@400;700', 'sans', 700, 400),
  jp_shippori:F('ja', 'Shippori Mincho', 'Shippori+Mincho:wght@400;700', 'serif', 700, 400),
  jp_zenold:  F('ja', 'Zen Old Mincho', 'Zen+Old+Mincho:wght@400;700', 'serif', 700, 400),
  jp_decol:   F('ja', 'Kaisei Decol', 'Kaisei+Decol:wght@400;700', 'serif', 700, 400),
  jp_zenmaru: F('ja', 'Zen Maru Gothic', 'Zen+Maru+Gothic:wght@400;700', 'rounded', 700, 400),
  jp_kosugi:  F('ja', 'Kosugi Maru', 'Kosugi+Maru', 'rounded'),
  jp_mplus:   F('ja', 'M PLUS Rounded 1c', 'M+PLUS+Rounded+1c:wght@400;700', 'rounded', 700, 400),
  jp_yuji:    F('ja', 'Yuji Syuku', 'Yuji+Syuku', 'script', 400, 400, 1.05),
  jp_klee:    F('ja', 'Klee One', 'Klee+One:wght@400;600', 'script', 600, 400),
  jp_yomogi:  F('ja', 'Yomogi', 'Yomogi', 'script', 400, 400, 1.05),
  jp_dela:    F('ja', 'Dela Gothic One', 'Dela+Gothic+One', 'display', 400, 400, 0.92),
};
const FONT_KEYS = Object.keys(FONTS);
const GROUP_SAMPLE = { latin: 'Aa', ko: '가나', sc: '你好', ja: 'あア' };
// запасной «родной» шрифт набора: если в декоративном нет редкого иероглифа
const GROUP_BASE = { ko: ['kr_sans', 'kr_serif'], sc: ['sc_sans', 'sc_serif'], ja: ['jp_sans', 'jp_serif'] };
const GENERIC = { serif: 'serif', sans: 'sans-serif', script: 'cursive', rounded: 'sans-serif', display: 'sans-serif' };

/** Письменность таблички: по самому тексту (кана → ja, хангыль → ko, иероглифы → по языку), иначе язык сайта. */
function scriptGroup(text) {
  const lang = (document.documentElement.lang || '').toLowerCase();
  const byLang = lang.startsWith('ja') ? 'ja' : lang.startsWith('ko') ? 'ko' : lang.startsWith('zh') ? 'sc' : null;
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(text)) return 'ko';
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(text)) return byLang || 'sc';
  return byLang || 'latin';
}
const groupFonts = (g) => FONT_KEYS.filter(k => FONTS[k].group === g);

/**
 * Шрифт для этой письменности. Сохранённый годится, если он из того же
 * набора; иначе берём шрифт того же характера (serif → serif…), иначе первый.
 */
function resolveFont(want, design, group) {
  if (want && FONTS[want]?.group === group) return want;
  const list = groupFonts(group);
  const cat = FONTS[want || DESIGNS[design].font]?.cat;
  if (group === 'latin' && !want) return DESIGNS[design].font;
  return list.find(k => FONTS[k].cat === cat) || list[0];
}
/** Родной запасной шрифт CJK-набора (Noto того же характера) — или null. */
function baseFont(key) {
  const f = FONTS[key], pair = GROUP_BASE[f.group];
  if (!pair) return null;
  const b = f.cat === 'serif' ? pair[1] : pair[0];
  return b === key ? null : b;
}
function fontStack(key) {
  const f = FONTS[key], b = baseFont(key);
  return [`'${f.fam}'`, b ? `'${FONTS[b].fam}'` : null, GENERIC[f.cat]].filter(Boolean).join(', ');
}

const linked = new Set();
function addCss(href) {
  if (linked.has(href)) return Promise.resolve();
  linked.add(href);
  return new Promise((res) => {
    document.head.appendChild(el('link', { rel: 'stylesheet', href, onload: () => res(), onerror: () => res() }));
    setTimeout(res, 5000);
  });
}
/** Подгружает шрифт (и родной запасной для CJK) ровно под набранный текст. */
export async function loadSignFont(key, text) {
  const f = FONTS[key] || FONTS.inter;
  const b = baseFont(FONTS[key] ? key : 'inter');
  const fams = b ? [f, FONTS[b]] : [f];
  await addCss(`https://fonts.googleapis.com/css2?${fams.map(x => 'family=' + x.q).join('&')}&display=swap`);
  const sample = text || GROUP_SAMPLE[f.group];
  const jobs = [];
  for (const x of fams) for (const w of new Set([x.w, x.w2])) jobs.push(document.fonts.load(`${w} 40px '${x.fam}'`, sample).catch(() => null));
  await Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, 8000))]);
}
/** Превью плиток: один запрос на весь набор, text= — крошечные файлы под образец. */
function loadFontPreviews(group) {
  const q = groupFonts(group).map(k => 'family=' + FONTS[k].q).join('&');
  return addCss(`https://fonts.googleapis.com/css2?${q}&text=${encodeURIComponent(GROUP_SAMPLE[group])}&display=swap`);
}

// Готовые сочетания: акцент / фон / текст. Первое — «как задумано дизайном».
const PALETTES = [
  null,
  { acc: '#B08D2E', bg: '#FBF7EE', ink: '#3A2F1E' },
  { acc: '#D98C9F', bg: '#FFF8F5', ink: '#4A3A3C' },
  { acc: '#7C9A7E', bg: '#F7F8F2', ink: '#2F3B2F' },
  { acc: '#E9C46A', bg: '#13224A', ink: '#F6F1E4' },
  { acc: '#8E44AD', bg: '#FCF9FF', ink: '#2E1A47' },
  { acc: '#C0623B', bg: '#FFF8F1', ink: '#3B2418' },
  { acc: '#141414', bg: '#FFFFFF', ink: '#141414' },
];

export const defaultSign = () => ({
  v: 2, design: 'plain', orient: 'v', colors: null, photo: null, font: null,
  lines: { name: true, share: true, custom: false }, title: null, custom: '',
});

function normalize(cfg) {
  const d = defaultSign();
  if (!cfg || typeof cfg !== 'object') return d;
  const hex = (x) => (typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x) ? x : null);
  const c = cfg.colors && typeof cfg.colors === 'object'
    ? { acc: hex(cfg.colors.acc), bg: hex(cfg.colors.bg), ink: hex(cfg.colors.ink) } : null;
  const ln = cfg.lines && typeof cfg.lines === 'object' ? cfg.lines : d.lines;
  return {
    v: 2,
    design: DESIGN_KEYS.includes(cfg.design) ? cfg.design : d.design,
    orient: cfg.orient === 'h' ? 'h' : 'v',
    colors: c && c.acc && c.bg && c.ink ? c : null,
    photo: normPhoto(cfg.photo),
    font: FONT_KEYS.includes(cfg.font) ? cfg.font : null,
    lines: { name: ln.name !== false, share: !!ln.share, custom: !!ln.custom },
    title: typeof cfg.title === 'string' && cfg.title.trim() ? cfg.title.trim().slice(0, 120) : null,
    custom: typeof cfg.custom === 'string' ? cfg.custom.slice(0, 200) : '',
  };
}

const groupOf = (cfg, info) => scriptGroup(signText(cfg, info));
/** Фото баннера: путь, размеры оригинала, кадрирование {cx,cy,z} и источник (cover|album|own). */
function normPhoto(p) {
  if (!p || typeof p.path !== 'string') return null;
  const num = (x, lo, hi, d) => (Number.isFinite(+x) ? Math.min(hi, Math.max(lo, +x)) : d);
  const c = p.crop && typeof p.crop === 'object' ? p.crop : {};
  return {
    id: String(p.id || ''), path: p.path, thumb: typeof p.thumb === 'string' ? p.thumb : p.path,
    w: num(p.w, 0, 20000, 0) || null, h: num(p.h, 0, 20000, 0) || null,
    src: ['cover', 'album', 'own'].includes(p.src) ? p.src : 'album',
    crop: { cx: num(c.cx, 0, 1, 0.5), cy: num(c.cy, 0, 1, 0.5), z: num(c.z, 1, 4, 1) },
  };
}

/**
 * Где стоит картинка в рамке fw×fh: «cover» × zoom, центр кадра — (cx,cy) в
 * долях картинки, с упором в края (пустых полей не бывает). Одна формула для
 * окна кадрирования, предпросмотра и печати — поэтому печать совпадает.
 */
export function cropBox(fw, fh, iw, ih, crop) {
  const s = Math.max(fw / iw, fh / ih) * (crop?.z || 1);
  const dw = iw * s, dh = ih * s;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const cx = clamp(crop?.cx ?? 0.5, fw / (2 * dw), 1 - fw / (2 * dw));
  const cy = clamp(crop?.cy ?? 0.5, fh / (2 * dh), 1 - fh / (2 * dh));
  return { w: dw, h: dh, left: fw / 2 - cx * dw, top: fh / 2 - cy * dh, cx, cy };
}
function placeImg(img, fw, fh, photo, dims) {
  const iw = photo.w || dims?.w, ih = photo.h || dims?.h;
  if (!img || !iw || !ih || !fw || !fh) {
    if (img) img.style.cssText = `width:100%;height:100%;object-fit:cover;object-position:${photo.crop.cx * 100}% ${photo.crop.cy * 100}%`;
    return;
  }
  const b = cropBox(fw, fh, iw, ih, photo.crop);
  img.style.cssText = `position:absolute;max-width:none;width:${b.w}px;height:${b.h}px;left:${b.left}px;top:${b.top}px`;
}

const dimCache = new Map();
/** Размеры картинки по ссылке (для кадрирования, когда в media их нет). */
export function imgDims(url) {
  if (!url) return Promise.resolve(null);
  if (!dimCache.has(url)) {
    dimCache.set(url, new Promise((res) => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => res(null);
      im.src = url;
    }));
  }
  return dimCache.get(url);
}

const fontOf = (cfg, info) => resolveFont(cfg.font, cfg.design, groupOf(cfg, info));
/** Весь текст таблички — для подбора CJK-шрифта и подгрузки нужных глифов. */
function signText(cfg, info) {
  return [cfg.lines.name ? (cfg.title || info.title || '') : '', cfg.lines.share ? t('qs_line_share') : '',
    cfg.lines.custom ? cfg.custom : ''].join(' ');
}

/* ------------------------------------------------------------ хранение */

/**
 * Сохранённая табличка: колонка albums.event_sign (миграция 057), а пока её
 * нет — localStorage этого устройства. Возвращает {cfg, where}.
 */
export async function loadSign(albumId) {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(LS_KEY(albumId)) || 'null'); } catch (_) { /* мусор */ }
  const { data, error } = await sb.from('albums').select('event_sign').eq('id', albumId).maybeSingle();
  if (!error && data?.event_sign) return { cfg: normalize(data.event_sign), saved: true };
  if (local) return { cfg: normalize(local), saved: true };
  return { cfg: defaultSign(), saved: false };
}

export async function saveSign(albumId, cfg) {
  const clean = normalize(cfg);
  const { error } = await sb.from('albums').update({ event_sign: clean }).eq('id', albumId);
  if (!error) { localStorage.removeItem(LS_KEY(albumId)); return { ok: true, local: false }; }
  // Колонки ещё нет (миграция не применена) — держим на устройстве.
  const missing = /event_sign|column|schema cache/i.test(error.message || '') || error.code === '42703' || error.code === 'PGRST204';
  if (missing) { localStorage.setItem(LS_KEY(albumId), JSON.stringify(clean)); return { ok: true, local: true }; }
  return { ok: false, error };
}

/* ------------------------------------------------------------ украшения */

const NS = 'http://www.w3.org/2000/svg';
function svgEl(markup, attrs = '') {
  const w = document.createElement('div');
  w.innerHTML = `<svg xmlns="${NS}" ${attrs}>${markup}</svg>`;
  return w.firstChild;
}
const mix = (pct, other = 'white') => `color-mix(in srgb, var(--acc) ${pct}%, ${other})`;

/** Детерминированный «случай»: одинаковые звёзды и брызги на экране и на бумаге. */
function rng(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

function flower(cx, cy, r, rot, fill, core) {
  let p = '';
  for (let i = 0; i < 5; i++) {
    const a = rot + i * 72;
    p += `<ellipse cx="${cx}" cy="${cy - r * 0.55}" rx="${r * 0.42}" ry="${r * 0.62}" transform="rotate(${a} ${cx} ${cy})" style="fill:${fill}"/>`;
  }
  return p + `<circle cx="${cx}" cy="${cy}" r="${r * 0.24}" style="fill:${core}"/>`;
}
function leaf(x, y, len, rot, fill) {
  return `<path d="M0 0 C ${len * 0.35} ${-len * 0.28}, ${len * 0.75} ${-len * 0.22}, ${len} 0 C ${len * 0.75} ${len * 0.22}, ${len * 0.35} ${len * 0.28}, 0 0 Z" transform="translate(${x} ${y}) rotate(${rot})" style="fill:${fill}"/>`
    + `<path d="M0 0 L ${len * 0.9} 0" transform="translate(${x} ${y}) rotate(${rot})" style="stroke:rgba(255,255,255,.55);stroke-width:1.2;fill:none"/>`;
}
function bouquet() {
  const g1 = '#8FAF8B', g2 = '#B5CBAE';
  let s = '';
  s += leaf(40, 210, 120, -20, g1) + leaf(70, 60, 110, 35, g2) + leaf(150, 30, 100, -5, g1) + leaf(20, 120, 90, 60, g2)
    + leaf(200, 70, 90, 20, g2) + leaf(90, 170, 100, -50, g1);
  s += flower(95, 95, 62, 10, mix(55), mix(100, '#7a4a20'));
  s += flower(185, 52, 40, 30, mix(35), mix(90, '#7a4a20'));
  s += flower(48, 182, 42, 50, mix(75), mix(100, '#7a4a20'));
  s += flower(170, 150, 28, 5, mix(25), mix(80, '#7a4a20'));
  const r = rng(7);
  for (let i = 0; i < 14; i++) s += `<circle cx="${30 + r() * 250}" cy="${20 + r() * 240}" r="${2 + r() * 4}" style="fill:${mix(45)}"/>`;
  return s;
}

function blob(cx, cy, r, seed) {
  const k = rng(seed); const n = 9; const pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const rr = r * (0.72 + k() * 0.5); pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n];
    const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
    d += ` Q${p0[0]} ${p0[1]} ${mx} ${my}`;
  }
  return d + 'Z';
}

let uid = 0;
function decorations(design, W, H) {
  const box = el('div', { class: 'qs-deco' });
  const u = `q${++uid}`;   // свои id у каждой копии: превью и печать живут на одной странице
  if (design === 'flowers') {
    box.append(
      svgEl(bouquet(), `class="qs-fl qs-fl-a" viewBox="0 0 300 280"`),
      svgEl(bouquet(), `class="qs-fl qs-fl-b" viewBox="0 0 300 280"`));
  } else if (design === 'moon') {
    const r = rng(11); let stars = '';
    for (let i = 0; i < 90; i++) {
      const x = r() * W, y = r() * H * 0.9, s = r();
      stars += s > 0.93
        ? `<path d="M${x} ${y - 6}L${x + 1.4} ${y - 1.4}L${x + 6} ${y}L${x + 1.4} ${y + 1.4}L${x} ${y + 6}L${x - 1.4} ${y + 1.4}L${x - 6} ${y}L${x - 1.4} ${y - 1.4}Z" style="fill:${mix(70)}"/>`
        : `<circle cx="${x}" cy="${y}" r="${0.6 + s * 1.5}" fill="#fff" opacity="${0.35 + s * 0.6}"/>`;
    }
    const mx = W - 92, my = 88;
    box.append(svgEl(`<defs><radialGradient id="qsglow${u}"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <mask id="qsmoon${u}"><rect width="${W}" height="${H}" fill="#fff"/><circle cx="${mx + 20}" cy="${my - 14}" r="40" fill="#000"/></mask></defs>
      ${stars}<circle cx="${mx}" cy="${my}" r="100" fill="url(#qsglow${u})"/>
      <circle cx="${mx}" cy="${my}" r="44" mask="url(#qsmoon${u})" style="fill:${mix(55)}"/>
      <path d="M0 ${H} L0 ${H - 70} C ${W * 0.2} ${H - 120}, ${W * 0.35} ${H - 60}, ${W * 0.55} ${H - 95} S ${W * 0.85} ${H - 70}, ${W} ${H - 110} L${W} ${H} Z" fill="#000" opacity=".22"/>
      <path d="M0 ${H} L0 ${H - 35} C ${W * 0.25} ${H - 70}, ${W * 0.5} ${H - 20}, ${W * 0.7} ${H - 55} S ${W * 0.9} ${H - 40}, ${W} ${H - 60} L${W} ${H} Z" fill="#000" opacity=".25"/>`,
    `viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"`));
  } else if (design === 'splash') {
    const r = rng(23); let drops = '';
    for (let i = 0; i < 26; i++) {
      const corner = i % 2, x = corner ? W - r() * 260 : r() * 240, y = corner ? r() * 260 : H - r() * 260;
      drops += `<circle cx="${x}" cy="${y}" r="${2 + r() * 9}" style="fill:${mix(40 + r() * 60)}" opacity="${0.5 + r() * 0.5}"/>`;
    }
    box.append(svgEl(`
      <path d="${blob(W - 40, 30, 190, 3)}" style="fill:${mix(30)}"/>
      <path d="${blob(W - 70, 60, 120, 5)}" style="fill:${mix(65)}" opacity=".85"/>
      <path d="${blob(W - 20, 170, 55, 9)}" style="fill:${mix(100, '#3a1050')}" opacity=".7"/>
      <path d="${blob(30, H - 30, 200, 13)}" style="fill:${mix(25)}"/>
      <path d="${blob(60, H - 70, 120, 17)}" style="fill:${mix(55)}" opacity=".85"/>
      <path d="${blob(190, H - 20, 60, 19)}" style="fill:${mix(100, '#3a1050')}" opacity=".6"/>${drops}`,
    `viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"`));
  } else if (design === 'gold') {
    const corner = `<path d="M6 70 C 6 30, 30 6, 70 6" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <path d="M18 70 C 18 38, 38 18, 70 18" fill="none" stroke="currentColor" stroke-width=".8"/>
      <path d="M30 40 c 10 -2 14 -10 10 -16 c -6 4 -12 8 -10 16z M40 30 c 2 -10 10 -14 16 -10 c -4 6 -8 12 -16 10z" fill="currentColor"/>
      <circle cx="26" cy="26" r="3" fill="currentColor"/>`;
    box.append(el('div', { class: 'qs-frame1' }), el('div', { class: 'qs-frame2' }),
      ...['tl', 'tr', 'br', 'bl'].map(c => svgEl(corner, `class="qs-corner qs-${c}" viewBox="0 0 80 80"`)));
  } else if (design === 'water') {
    box.append(svgEl(`<defs><filter id="qsblur${u}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="38"/></filter></defs>
      <g filter="url(#qsblur${u})">
        <circle cx="60" cy="40" r="170" fill="#F6C9D0" opacity=".75"/>
        <circle cx="${W * 0.45}" cy="-30" r="130" style="fill:${mix(60)}" opacity=".65"/>
        <circle cx="${W}" cy="110" r="150" fill="#CFE6D8" opacity=".8"/>
        <circle cx="${W - 40}" cy="${H - 40}" r="190" style="fill:${mix(55)}" opacity=".6"/>
        <circle cx="40" cy="${H - 60}" r="150" fill="#FBE3C4" opacity=".75"/>
        <circle cx="${W * 0.55}" cy="${H + 30}" r="120" fill="#E3D5F2" opacity=".7"/>
      </g>`, `viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"`));
  } else if (design === 'neon') {
    box.append(el('div', { class: 'qs-neon-frame' }));
  }
  return box;
}

/* ------------------------------------------------------------ табличка */

function titleSize(text, orient, photo) {
  const n = [...text].reduce((m, ch) => m + (/[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 2.2 : 1), 0);
  const base = orient === 'h' ? [60, 52, 44, 36, 30] : [70, 60, 50, 42, 34];
  const i = n <= 12 ? 0 : n <= 20 ? 1 : n <= 32 ? 2 : n <= 60 ? 3 : 4;
  return Math.round(base[i] * (photo && orient === 'v' ? 0.9 : 1));
}

const isWide = (ch) => /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch);
/** Грубая оценка числа строк: ширина символа ~0.55em (латиница) или 1em (CJK). */
function estLines(text, size, width) {
  if (!text) return 0;
  return text.split('\n').reduce((n, part) => {
    const w = [...part].reduce((m, ch) => m + (isWide(ch) ? 1 : 0.56), 0) * size;
    return n + Math.max(1, Math.ceil(w / width));
  }, 0);
}

/**
 * Раскладка «по бюджету»: всё обязано влезть на лист. Сначала ужимаем фото,
 * потом QR (не меньше ~80 мм — код остаётся крупным), потом кегль текста.
 */
function layout(cfg, F, title, photo, W, H) {
  const v = cfg.orient === 'v';
  let ts = Math.round(titleSize(title, cfg.orient, photo) * F.k);
  let qr = v ? (photo ? 330 : 420) : (photo ? 360 : 390);
  let ph = photo ? (v ? 270 : 230) : 0;
  const share = cfg.lines.share ? t('qs_line_share') : '';
  const custom = cfg.lines.custom ? cfg.custom.trim() : '';
  const textH = (k) => {
    const width = v ? W - 150 : W - 156 - 56 - (qr + 32) - 10;
    const tsz = ts * k, ssz = 26 * F.k * k, csz = 21 * F.k * k;
    let h = 0;
    if (cfg.lines.name && title) h += estLines(title, tsz, width) * tsz * 1.15;
    if (cfg.lines.name && title && (share || custom)) h += 52;
    if (share) h += estLines(share, ssz, width) * ssz * 1.4;
    if (custom) h += estLines(custom, csz, width) * csz * 1.45 + 12;
    return h;
  };
  let k = 1;
  const need = () => (v
    ? (photo ? 62 : 78) + 96 + (ph ? ph + 18 : 0) + textH(k) + (qr + 32) + 34
    : 128 + (ph ? ph + 30 : 0) + textH(k) + 70);
  const room = H - 10;
  while (need() > room && ph > (v ? 150 : 120)) ph -= 10;
  if (v) while (need() > room && qr > 310) qr -= 10;
  while (need() > room && k > 0.6) k -= 0.04;
  return { ts: Math.round(ts * k), k: F.k * k, qr, ph, ts0: ts, k0: F.k };
}

/**
 * DOM таблички. info: {title, url, photoUrl}. Размер — «бумажный» (см. SIZE).
 */
export function renderSign(cfgIn, info) {
  injectCss();
  const cfg = normalize(cfgIn);
  const d = DESIGNS[cfg.design];
  const c = cfg.colors || d;
  const [W, H] = SIZE[cfg.orient];
  const title = cfg.title || info.title || '';
  const photo = cfg.photo && info.photoUrl;
  const fk = fontOf(cfg, info), F = FONTS[fk];

  const L = layout(cfg, F, title, photo, W, H);
  const qrSize = L.qr;
  const card = el('div', { class: 'qs-card' });
  card.appendChild(qrSvg(info.url, qrSize));

  const root = el('div', {
    class: `qs qs-${cfg.design} qs-${cfg.orient} qs-f-${F.cat} qs-g-${F.group}${photo ? ' qs-has-photo' : ''}`,
    style: `width:${W}px;height:${H}px;--acc:${c.acc};--bg:${c.bg};--ink:${c.ink};`
      + `--tsize:${L.ts}px;--k:${L.k};--ph:${L.ph}px;`
      + `--ff:${fontStack(fk)};--fw:${F.w};--fw2:${F.w2}`,
  });
  root.appendChild(decorations(cfg.design, W, H));
  // строки над кодом — в фиксированном порядке: название, «поделитесь», свой текст
  const lines = [];
  if (cfg.lines.name && title) lines.push(el('h1', { class: 'qs-title', text: title }));
  if (cfg.lines.name && title && (cfg.lines.share || (cfg.lines.custom && cfg.custom.trim()))) {
    lines.push(el('div', { class: 'qs-rule' }, el('i'), el('b'), el('i')));
  }
  if (cfg.lines.share) lines.push(el('p', { class: 'qs-sub', text: t('qs_line_share') }));
  if (cfg.lines.custom && cfg.custom.trim()) lines.push(el('p', { class: 'qs-custom', text: cfg.custom.trim() }));
  const text = lines.length ? el('div', { class: 'qs-text' }, ...lines) : null;
  // ссылку под кодом не печатаем: QR и так ведёт по ней, а длинная строка с токеном только шумит
  const code = el('div', { class: 'qs-code' }, card);
  const ph = photo ? el('div', { class: 'qs-photo' }, el('img', { src: info.photoUrl, alt: '' })) : null;
  root._photoDims = info.photoDims || null;
  const brand = el('div', { class: 'qs-brand', text: 'albums.ink' });

  const inner = el('div', { class: 'qs-inner' });
  if (cfg.orient === 'v') inner.append(...[ph, text, code, brand].filter(Boolean));
  else inner.append(el('div', { class: 'qs-left' }, ...[ph, text, brand].filter(Boolean)), code);
  root.appendChild(inner);
  fit(root, cfg, L);
  return root;
}

/**
 * Подгонка по факту: табличку ставим во внеэкранный контейнер, меряем и
 * ужимаем, пока всё не влезет без наложений — сначала фото, потом QR
 * (не меньше ~80 мм), потом кегль текста. Оценка layout() — лишь старт.
 */
function fit(root, cfg, L) {
  if (!document.body) return;
  const v = cfg.orient === 'v';
  const off = el('div', { style: 'position:fixed;left:-20000px;top:0;visibility:hidden;pointer-events:none' }, root);
  document.body.appendChild(off);
  const svg = root.querySelector('.qs-card svg');
  const R = () => root.getBoundingClientRect();
  const q = (sel) => root.querySelector(sel)?.getBoundingClientRect();
  const over = () => {
    const r = R();
    if (v) {
      const code = q('.qs-card'), brand = q('.qs-brand'), first = root.querySelector('.qs-inner').firstElementChild.getBoundingClientRect();
      return first.top < r.top + 24 || code.bottom > brand.top - 14;
    }
    const left = root.querySelector('.qs-left'), last = left.lastElementChild.getBoundingClientRect(), first = left.firstElementChild.getBoundingClientRect();
    return last.bottom > r.bottom - 40 || first.top < r.top + 30;
  };
  let { ph, qr } = L, k = 1;
  const minPh = v ? 140 : 110;
  // сначала пробуем вернуть то, что оценка зря отняла
  ph = cfg.photo && L.ph ? (v ? 300 : 240) : 0;
  qr = v ? (ph ? 360 : 460) : qr;
  const apply = () => {
    root.style.setProperty('--ph', ph + 'px');
    root.style.setProperty('--tsize', Math.round(L.ts0 * k) + 'px');
    root.style.setProperty('--k', String(L.k0 * k));
    svg.setAttribute('width', String(qr)); svg.setAttribute('height', String(qr));
  };
  const placePhoto = () => {
    const box = root.querySelector('.qs-photo');
    if (box) placeImg(box.querySelector('img'), box.clientWidth, box.clientHeight, cfg.photo, root._photoDims);
  };
  apply();
  // Длинное слово («Let's gooooo…») не рвём посреди строки: сначала уменьшаем
  // кегль именно этой строки, пока самое длинное слово не встанет целиком
  // (до 45%). Не хватило — тогда уже перенос где угодно (overflow-wrap:anywhere).
  root.classList.add('qs-measure');
  root.querySelectorAll('.qs-title,.qs-sub,.qs-custom').forEach((n) => {
    let f = 1;
    while (n.scrollWidth > n.clientWidth + 1 && f > 0.45) { f -= 0.05; n.style.setProperty('--wf', f.toFixed(2)); }
  });
  root.classList.remove('qs-measure');
  for (let i = 0; i < 80 && over(); i++) {
    if (ph > minPh) ph -= 10;
    else if (v && qr > 310) qr -= 10;
    else if (k > 0.55) k -= 0.04;
    else break;
    apply();
  }
  placePhoto();
  off.remove();
  root.remove();
}

/** Ссылка на фото баннера (подписанная) — или null. */
async function photoUrl(cfg) {
  if (!cfg.photo) return null;
  try { const u = await signUrls([cfg.photo.path, cfg.photo.thumb]); return u[cfg.photo.path] || u[cfg.photo.thumb] || null; }
  catch (_) { return null; }
}

/** Дождаться шрифтов таблички (под её текст) — перед печатью и снимками. */
export async function signFontsReady(cfgIn, info) {
  const cfg = normalize(cfgIn);
  await loadSignFont(fontOf(cfg, info), signText(cfg, info));
  try { await document.fonts.ready; } catch (_) { /* ок */ }
}

/* ------------------------------------------------------------ печать */

/**
 * Печатает табличку в этом же окне: на время печати страница прячется
 * целиком, остаётся одна табличка на одном листе. Всплывающих окон нет —
 * их режут браузеры, а шрифты и фото уже загружены здесь.
 */
export async function printSign(cfgIn, info) {
  const { cfg, sign } = await prepareSign(cfgIn, info);
  document.getElementById('qs-print')?.remove();
  const host = el('div', { id: 'qs-print', style: `background:${(cfg.colors || DESIGNS[cfg.design]).bg}` }, sign);
  const page = el('style', { id: 'qs-page', text: `@page{size:A4 ${cfg.orient === 'h' ? 'landscape' : 'portrait'};margin:0}` });
  document.getElementById('qs-page')?.remove();
  document.head.appendChild(page);
  document.body.appendChild(host);
  await signSettled(host);
  const done = () => { host.remove(); page.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(() => { if (document.getElementById('qs-print') === host && !matchMedia('print').matches) done(); }, 60000);
}

/** «Печать QR»: просто код по центру чистого листа A4, над ним — название альбома. */
export async function printPlainQr(url, title) {
  injectCss();
  document.getElementById('qs-print')?.remove();
  const host = el('div', { id: 'qs-print', class: 'qs-print-plain' },
    el('div', { class: 'qs-plain' },
      title ? el('h1', { text: title }) : null,
      qrSvg(url, 430),
      el('div', { class: 'qs-plain-brand', text: 'albums.ink' })));
  const page = el('style', { id: 'qs-page', text: '@page{size:A4 portrait;margin:0}' });
  document.getElementById('qs-page')?.remove();
  document.head.appendChild(page);
  document.body.appendChild(host);
  try { await document.fonts.ready; } catch (_) { /* ок */ }
  const done = () => { host.remove(); page.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(() => { if (document.getElementById('qs-print') === host && !matchMedia('print').matches) done(); }, 60000);
}

/** Табличка, готовая к выводу: фото подписано и измерено, шрифты загружены ДО раскладки. */
async function prepareSign(cfgIn, info) {
  injectCss();
  const cfg = normalize(cfgIn);
  const url = await photoUrl(cfg);
  try { await loadSignFont(fontOf(cfg, info), signText(cfg, info)); await document.fonts.ready; } catch (_) { /* чем есть */ }
  const dims = url ? await imgDims(url) : null;
  return { cfg, sign: renderSign(cfg, { ...info, photoUrl: url, photoDims: dims }) };
}
async function signSettled(host) {
  const img = host.querySelector('.qs-photo img');
  try { if (img) await Promise.race([img.decode(), new Promise(r => setTimeout(r, 4000))]); } catch (_) { /* без фото */ }
  try { await document.fonts.ready; } catch (_) { /* ок */ }
}

/* ------------------------------------------------------------ превью на странице события */

/**
 * Уменьшенная сохранённая табличка для панели «QR для гостей». Возвращает
 * узел сразу (с местом под пропорции), сама табличка дорисовывается следом.
 */
export function signPreview(cfgIn, info) {
  injectCss();
  const cfg = normalize(cfgIn);
  const [W, H] = SIZE[cfg.orient];
  const box = el('div', { class: 'qs-preview', style: `aspect-ratio:${W}/${H}` });
  prepareSign(cfg, info).then(({ sign }) => {
    const paint = () => { const k = box.clientWidth / W; if (k) sign.style.transform = `scale(${k})`; };
    clear(box).appendChild(sign); paint();
    new ResizeObserver(paint).observe(box);
  });
  return box;
}

/* ------------------------------------------------------------ скачивание дизайна */

const A4 = { v: [210, 297], h: [297, 210] };
const loadScript = (src) => new Promise((res, rej) => {
  const s = el('script', { src }); s.onload = res; s.onerror = () => rej(new Error('script ' + src));
  document.head.appendChild(s);
});

/**
 * CSS @font-face только под текст таблички: Google Fonts с &text= отдаёт по
 * одному маленькому файлу на начертание — даже для китайского или японского.
 * Семейства берём из шрифтов дизайна и ссылок Google Fonts на странице.
 */
async function signFontCss(sign) {
  const params = new Map();
  for (const f of Object.values(FONTS)) params.set(f.fam, f.q);
  document.querySelectorAll('link[href*="fonts.googleapis.com/css"]').forEach((l) => {
    try { new URL(l.href).searchParams.getAll('family').forEach((q) => params.set(q.split(':')[0].replace(/\+/g, ' '), q)); } catch (_) { /* мимо */ }
  });
  const used = new Set();
  [sign, ...sign.querySelectorAll('*')].forEach((n) => {
    getComputedStyle(n).fontFamily.split(',').forEach((x) => { const name = x.trim().replace(/^["']|["']$/g, ''); if (params.has(name)) used.add(name); });
  });
  if (!used.size) return '';
  const text = Array.from(new Set(Array.from(sign.textContent + 'albums.ink ALBUMS.INK'))).join('');
  const qs = [...used].map((n) => 'family=' + params.get(n).replace(/ /g, '+')).join('&');
  const r = await fetch(`https://fonts.googleapis.com/css2?${qs}&text=${encodeURIComponent(text)}&display=block`);
  return r.ok ? r.text() : '';
}

/** Картинка → data: URL (банер встраиваем сами — и для Safari, и чтобы знать об ошибке). */
async function inlineImg(img) {
  if (!img || img.src.startsWith('data:')) return;
  const b = await (await fetch(img.src, { mode: 'cors' })).blob();
  img.src = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
  await img.decode().catch(() => null);
}

/**
 * Готовый файл дизайна. PNG — A4 при 300 dpi (2480×3508 или 3508×2480).
 * PDF — один лист A4 в край: фон и текст картинкой 300 dpi, QR поверх —
 * вектором из тех же модулей, что в SVG таблички (печатается идеально чётко).
 */
export async function exportSign(cfgIn, info, fmt) {
  const { cfg, sign } = await prepareSign(cfgIn, info);
  const [W, H] = SIZE[cfg.orient];
  const host = el('div', { class: 'qs-export', style: `position:fixed;left:-30000px;top:0;width:${W}px;height:${H}px` }, sign);
  document.body.appendChild(host);
  try {
    await signSettled(host);
    try { await inlineImg(sign.querySelector('.qs-photo img')); } catch (_) { /* без банера, но файл всё равно будет */ }
    let cssText = '';
    try { cssText = await signFontCss(sign); } catch (_) { /* системные шрифты */ }
    const { domToCanvas } = await import('./vendor/modern-screenshot.js');
    const px = cfg.orient === 'v' ? 2480 : 3508;
    const canvas = await domToCanvas(sign, {
      width: W, height: H, scale: px / W, backgroundColor: (cfg.colors || DESIGNS[cfg.design]).bg,
      font: cssText ? { cssText } : false, timeout: 20000,
      style: { transform: 'none' },
    });
    const name = (info.title || 'albums-ink').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) || 'albums-ink';
    if (fmt === 'png') {
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      saveBlob(blob, `${name} - QR sign.png`);
      return;
    }
    if (!window.jspdf) await loadScript(new URL('./vendor/jspdf.umd.min.js', import.meta.url).href);
    const [pw, ph] = A4[cfg.orient];
    const pdf = new window.jspdf.jsPDF({ orientation: cfg.orient === 'h' ? 'landscape' : 'portrait', unit: 'mm', format: 'a4', compress: true });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
    vectorQr(pdf, sign, pw / W);
    pdf.setProperties({ title: info.title || 'QR sign', creator: 'albums.ink' });
    saveBlob(pdf.output('blob'), `${name} - QR sign.pdf`);
  } finally { host.remove(); }
}

/** QR из SVG таблички — в PDF прямоугольниками (k: мм на CSS-пиксель). */
function vectorQr(pdf, sign, k) {
  const svg = sign.querySelector('.qs-card svg');
  if (!svg) return;
  const R = sign.getBoundingClientRect(), r = svg.getBoundingClientRect();
  const total = svg.viewBox.baseVal.width, m = (r.width / total) * k;
  const x0 = (r.left - R.left) * k, y0 = (r.top - R.top) * k;
  pdf.setFillColor(255, 255, 255); pdf.rect(x0, y0, total * m, total * m, 'F');
  pdf.setFillColor(20, 20, 20);
  // модули склеиваем в горизонтальные полоски: меньше объектов, нет швов
  const cells = new Set();
  for (const mt of svg.querySelector('path').getAttribute('d').matchAll(/M(\d+) (\d+)/g)) cells.add(mt[1] + ',' + mt[2]);
  for (let y = 0; y < total; y++) {
    for (let x = 0; x < total; x++) {
      if (!cells.has(x + ',' + y)) continue;
      let w = 1; while (cells.has((x + w) + ',' + y)) w++;
      pdf.rect(x0 + x * m, y0 + y * m, w * m + 0.002, m + 0.002, 'F');
      x += w - 1;
    }
  }
  const plate = svg.querySelector('rect[rx]'), txt = svg.querySelector('text');
  if (plate && txt) {
    const a = (n, at) => +n.getAttribute(at);
    pdf.setDrawColor(20, 20, 20); pdf.setLineWidth(a(plate, 'stroke-width') * m); pdf.setFillColor(255, 255, 255);
    const rr = a(plate, 'rx') * m;
    pdf.roundedRect(x0 + a(plate, 'x') * m, y0 + a(plate, 'y') * m, a(plate, 'width') * m, a(plate, 'height') * m, rr, rr, 'FD');
    pdf.setFont('helvetica', 'bold'); pdf.setTextColor(20, 20, 20);
    const want = a(txt, 'textLength') * m, fs = a(txt, 'font-size') * m / 0.3528;
    pdf.setFontSize(fs);
    const w0 = pdf.getTextWidth(txt.textContent);
    pdf.setFontSize(fs * Math.min(1.25, want / w0));
    pdf.text(txt.textContent, x0 + a(txt, 'x') * m, y0 + a(txt, 'y') * m, { align: 'center', baseline: 'middle' });
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Маленькое окно выбора: PNG или PDF. */
export function openDownloadDesign(cfg, info) {
  modal((box, close) => {
    box.classList.add('qs-dl-modal');
    const status = el('div', { class: 'muted qs-dl-status' });
    const opt = (fmt, title, hint) => el('button', {
      type: 'button', class: 'qs-dl-opt', 'data-fmt': fmt, onclick: async (e) => {
        box.querySelectorAll('.qs-dl-opt').forEach(b => { b.disabled = true; });
        status.textContent = t('qs_dl_busy');
        try { await exportSign(cfg, info, fmt); close(); }
        catch (err) { console.error(err); status.textContent = t('qs_dl_failed'); box.querySelectorAll('.qs-dl-opt').forEach(b => { b.disabled = false; }); }
      },
    }, el('b', { text: title }), el('span', { text: hint }));
    box.append(
      el('div', { class: 'qs-head' }, el('h2', { text: t('qs_dl_title') }),
        el('button', { class: 'btn-icon', 'aria-label': t('cancel'), onclick: close }, '×')),
      el('div', { class: 'qs-dl-opts' },
        opt('png', 'PNG', t('qs_dl_png_hint')),
        opt('pdf', 'PDF', t('qs_dl_pdf_hint'))),
      status);
  });
}

/* ------------------------------------------------------------ редактор */

/**
 * Окно редактора. album: {id,title}; url — ссылка приглашения;
 * media: фото альбома [{id,storage_path,thumb_path,kind}]; current: сохранённое.
 */
export function openSignEditor({ album, url, media, current, onSaved }) {
  injectCss();
  let cfg = normalize(current);
  const photos = (media || []).filter(m => m.kind === 'photo' && (m.thumb_path || m.storage_path)).slice(0, 120);

  modal((box, close) => {
    box.classList.add('qs-modal');
    const stage = el('div', { class: 'qs-stage' });
    const view = el('div', { class: 'qs-view' }, stage);
    const ctrls = el('div', { class: 'qs-ctrls' });
    box.append(
      el('div', { class: 'qs-head' },
        el('h2', { text: t('qs_title') }),
        el('button', { class: 'btn-icon', 'aria-label': t('cancel'), onclick: close }, '×')),
      el('div', { class: 'qs-body' }, view, ctrls));

    let photoSrc = null; let drawSeq = 0; let lastFont = null;
    const fit = () => {
      const s = stage.firstChild; if (!s) return;
      const [W, H] = SIZE[cfg.orient];
      const cs = getComputedStyle(view), padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const k = Math.min((view.clientWidth - padX) / W, ((view.clientHeight - padY) || 99999) / H);
      s.style.transform = `scale(${k})`;
      stage.style.width = `${W * k}px`; stage.style.height = `${H * k}px`;
    };
    const draw = async () => {
      const seq = ++drawSeq;
      if (cfg.photo && (!photoSrc || photoSrc.key !== cfg.photo.path)) {
        const u = await photoUrl(cfg);
        const dm = await imgDims(u);
        if (seq !== drawSeq) return;
        photoSrc = { key: cfg.photo.path, url: u, dims: dm };
      }
      const fk = fontOf(cfg, { title: album.title }), txt = signText(cfg, { title: album.title });
      const fkey = fk + '|' + txt;
      if (fkey !== lastFont) {
        lastFont = fkey;
        // шрифт пришёл — перерисовать: подгонка размеров зависит от метрик шрифта
        loadSignFont(fk, txt).then(() => { if (seq === drawSeq) draw(); });
      }
      paintFonts();   // глифы подтянутся сами, без перерисовки
      clear(stage).appendChild(renderSign(cfg, { title: album.title, url, photoUrl: cfg.photo ? photoSrc?.url : null, photoDims: cfg.photo ? photoSrc?.dims : null }));
      fit();
    };
    const ro = new ResizeObserver(fit); ro.observe(view);

    const section = (label, ...kids) => el('div', { class: 'qs-sec' }, el('div', { class: 'label', text: label }), ...kids);
    const seg = (opts, get, set) => {
      const wrap = el('div', { class: 'qs-seg' });
      const paint = () => wrap.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === get()));
      opts.forEach(([v, txt]) => wrap.appendChild(el('button', { type: 'button', 'data-v': v, onclick: () => { set(v); paint(); draw(); } }, txt)));
      paint(); return wrap;
    };

    // ориентация
    ctrls.appendChild(section(t('qs_orient'), seg([['v', t('qs_vertical')], ['h', t('qs_horizontal')]], () => cfg.orient, v => { cfg.orient = v; })));

    // дизайн: плитки-миниатюры
    const grid = el('div', { class: 'qs-designs' });
    const paintDesigns = () => grid.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === cfg.design));
    DESIGN_KEYS.forEach(k => {
      const d = DESIGNS[k];
      grid.appendChild(el('button', {
        type: 'button', 'data-v': k, class: `qs-dtile qs-dt-${k}`,
        style: `--acc:${d.acc};--bg:${d.bg};--ink:${d.ink}`,
        onclick: () => { cfg.design = k; cfg.colors = null; cfg.font = null; paintDesigns(); paintSw(); paintFonts(); draw(); },
      }, el('span', { class: 'qs-dt-sw' }, el('i'), el('b', { text: 'Aa' })), el('span', { class: 'qs-dt-name', text: t('qs_d_' + k) })));
    });
    paintDesigns();
    ctrls.appendChild(section(t('qs_design'), grid));

    // цвета: палитры + свои
    const sw = el('div', { class: 'qs-swatches' });
    const pick = {};
    const colorRow = el('div', { class: 'qs-colors' });
    const cur = () => cfg.colors || DESIGNS[cfg.design];
    [['acc', t('qs_acc')], ['bg', t('qs_bg')], ['ink', t('qs_ink')]].forEach(([k, label]) => {
      const inp = el('input', { type: 'color', value: cur()[k] });
      inp.oninput = () => { cfg.colors = { ...cur(), [k]: inp.value }; paintSw(); draw(); };
      pick[k] = inp;
      colorRow.appendChild(el('label', { class: 'qs-color' }, inp, el('span', { text: label })));
    });
    function paintSw() {
      clear(sw);
      PALETTES.forEach((p, i) => {
        const c = p || DESIGNS[cfg.design];
        const on = p ? (cfg.colors && cfg.colors.acc === p.acc && cfg.colors.bg === p.bg && cfg.colors.ink === p.ink) : !cfg.colors;
        sw.appendChild(el('button', {
          type: 'button', class: 'qs-sw' + (on ? ' on' : ''), title: i === 0 ? t('qs_colors_design') : '',
          style: `background:${c.bg}`, onclick: () => { cfg.colors = p ? { ...p } : null; paintSw(); draw(); },
        }, el('i', { style: `background:${c.acc}` }), el('b', { style: `background:${c.ink}` })));
      });
      const c = cur(); Object.keys(pick).forEach(k => { pick[k].value = c[k]; });
    }
    paintSw();
    ctrls.appendChild(section(t('qs_colors'), sw, colorRow));

    // фото: без баннера · обложка альбома · своё загруженное · фото альбома · «+ Загрузить»
    const pgrid = el('div', { class: 'qs-photos' });
    const coverPath = album.cover_path || album.cover_thumb;
    const cover = coverPath ? { id: album.cover_media_id || '', path: coverPath, thumb: album.cover_thumb || coverPath, src: 'cover' } : null;
    let own = cfg.photo?.src === 'own' ? { ...cfg.photo } : null;
    const adjBtn = el('button', { type: 'button', class: 'mini qs-adjust', onclick: () => openCrop() }, t('qs_crop_title'));
    const paintPh = () => {
      pgrid.querySelectorAll('button[data-v]').forEach(b => b.classList.toggle('on', (b.dataset.v || '') === (cfg.photo?.path || '')));
      adjBtn.hidden = !cfg.photo;
    };
    const choose = (p) => {
      cfg.photo = normPhoto({ ...p, crop: null });
      if (p.src === 'own') own = cfg.photo;
      paintPh(); draw().then(() => openCrop());
    };
    const tile = (p, src, badge) => el('button', { type: 'button', class: 'qs-ph', 'data-v': p.path, onclick: () => choose(p) },
      el('img', { src: src || '', alt: '', loading: 'lazy' }), badge ? el('span', { class: 'qs-badge', text: badge }) : null);
    const fileIn = el('input', { type: 'file', accept: 'image/*,.heic,.heif', hidden: true });
    const upTile = el('button', { type: 'button', class: 'qs-ph qs-ph-up', onclick: () => fileIn.click() }, t('qs_photo_upload'));
    fileIn.onchange = async () => {
      const f = fileIn.files[0]; fileIn.value = '';
      if (!f) return;
      upTile.disabled = true; upTile.textContent = t('qs_photo_uploading');
      try {
        // В album_media не кладём: фото только для таблички — не в альбоме, не в ленте
        const m = await uploadMedia(f);
        if (m.kind !== 'photo') throw new Error(t('err_unsupported', { name: f.name }));
        choose({ id: m.id, path: m.storage_path, thumb: m.thumb_path || m.storage_path, w: m.width, h: m.height, src: 'own' });
        paintTiles();
      } catch (e) { toast(e.message || String(e)); }
      upTile.disabled = false; upTile.textContent = t('qs_photo_upload');
    };
    const paintTiles = async () => {
      const list = [cover, own].filter(Boolean);
      const seen = new Set(list.map(p => p.path));
      const alb = photos.filter(m => !seen.has(m.storage_path || m.thumb_path))
        .map(m => ({ id: m.id, path: m.storage_path || m.thumb_path, thumb: m.thumb_path || m.storage_path, w: m.width, h: m.height, src: 'album' }));
      let u = {};
      try { u = await signUrls([...list, ...alb].map(p => p.thumb)); } catch (_) { /* без превью */ }
      clear(pgrid).appendChild(el('button', { type: 'button', class: 'qs-ph qs-ph-none', 'data-v': '', onclick: () => { cfg.photo = null; paintPh(); draw(); } }, t('qs_photo_none')));
      if (cover) pgrid.appendChild(tile(cover, u[cover.thumb], t('qs_photo_cover')));
      if (own) pgrid.appendChild(tile(own, u[own.thumb], t('qs_photo_own')));
      alb.forEach(p => pgrid.appendChild(tile(p, u[p.thumb])));
      pgrid.appendChild(upTile);
      paintPh();
    };
    paintTiles();
    ctrls.appendChild(section(t('qs_photo'), pgrid, fileIn,
      el('div', { class: 'qs-photo-foot' }, el('span', { class: 'muted', text: t('qs_photo_hint') }), adjBtn)));

    // кадрирование: рамка — ровно слот баннера на текущей табличке
    async function openCrop() {
      if (!cfg.photo) return;
      let slot = stage.querySelector('.qs-photo');
      if (!slot) { await draw(); slot = stage.querySelector('.qs-photo'); }
      const url = photoSrc?.key === cfg.photo.path ? photoSrc.url : await photoUrl(cfg);
      if (!slot || !url) return;
      const dims = (cfg.photo.w && cfg.photo.h) ? { w: cfg.photo.w, h: cfg.photo.h } : await imgDims(url);
      if (!dims) return;
      const fw = slot.offsetWidth, fh = slot.offsetHeight;
      const st = { ...cfg.photo.crop };
      modal((box, close) => {
        box.classList.add('qs-crop-modal');
        const maxW = Math.min(520, innerWidth - 110), maxH = Math.min(360, innerHeight * 0.45);
        const d = Math.min(maxW / fw, maxH / fh);
        const img = el('img', { src: url, alt: '', draggable: 'false' });
        const frame = el('div', { class: 'qs-crop', style: `width:${fw * d}px;height:${fh * d}px` }, img);
        const zoom = el('input', { type: 'range', min: '1', max: '4', step: '0.01', value: String(st.z), 'aria-label': t('qs_crop_zoom') });
        const paint = () => {
          const b = cropBox(fw, fh, dims.w, dims.h, st);
          st.cx = b.cx; st.cy = b.cy;
          img.style.cssText = `width:${b.w * d}px;height:${b.h * d}px;left:${b.left * d}px;top:${b.top * d}px`;
          zoom.value = String(st.z);
        };
        let drag = null;
        frame.addEventListener('pointerdown', (e) => { frame.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY }; e.preventDefault(); });
        frame.addEventListener('pointermove', (e) => {
          if (!drag) return;
          const b = cropBox(fw, fh, dims.w, dims.h, st);
          st.cx -= (e.clientX - drag.x) / (b.w * d); st.cy -= (e.clientY - drag.y) / (b.h * d);
          drag = { x: e.clientX, y: e.clientY }; paint();
        });
        const end = () => { drag = null; };
        frame.addEventListener('pointerup', end); frame.addEventListener('pointercancel', end);
        frame.addEventListener('wheel', (e) => { e.preventDefault(); st.z = Math.min(4, Math.max(1, st.z * (e.deltaY < 0 ? 1.08 : 1 / 1.08))); paint(); }, { passive: false });
        zoom.oninput = () => { st.z = +zoom.value; paint(); };
        box.append(
          el('div', { class: 'qs-head' }, el('h2', { text: t('qs_crop_title') }),
            el('button', { class: 'btn-icon', 'aria-label': t('cancel'), onclick: close }, '×')),
          el('p', { class: 'muted', style: 'margin:0 0 12px;font-size:14px', text: t('qs_crop_hint') }),
          frame,
          el('label', { class: 'qs-zoom' }, el('span', { text: t('qs_crop_zoom') }), zoom),
          el('div', { class: 'qs-crop-btns' },
            el('button', { type: 'button', class: 'btn', onclick: () => { st.cx = 0.5; st.cy = 0.5; st.z = 1; paint(); } }, t('qs_crop_reset')),
            el('button', {
              type: 'button', class: 'btn btn-primary', onclick: () => {
                if (!cfg.photo) { close(); return; }
                cfg.photo.crop = { cx: +st.cx.toFixed(4), cy: +st.cy.toFixed(4), z: +st.z.toFixed(3) };
                if (!cfg.photo.w) { cfg.photo.w = dims.w; cfg.photo.h = dims.h; }
                if (cfg.photo.src === 'own') own = cfg.photo;
                close(); draw();
              },
            }, t('qs_crop_done'))));
        paint();
      });
    }

    // шрифт: плитки с образцом; набор — под письменность текста таблички
    const fgrid = el('div', { class: 'qs-fonts' });
    let fgroup = null;
    function paintFonts() {
      const info = { title: album.title };
      const g = groupOf(cfg, info), cur = fontOf(cfg, info);
      if (g !== fgroup) {
        fgroup = g; loadFontPreviews(g); clear(fgrid);
        groupFonts(g).forEach(k => fgrid.appendChild(el('button', {
          type: 'button', 'data-v': k, class: 'qs-font', title: FONTS[k].fam,
          onclick: () => { cfg.font = k; draw(); },
        }, el('b', { style: `font-family:'${FONTS[k].fam}',${GENERIC[FONTS[k].cat]};font-weight:${FONTS[k].w};font-size:${Math.round(22 * FONTS[k].k)}px`, text: GROUP_SAMPLE[g] }),
        el('span', { text: FONTS[k].fam }))));
      }
      fgrid.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === cur));
    }

    // строки над кодом: любые сочетания трёх флажков
    const check = (key, label, extra) => {
      const cb = el('input', { type: 'checkbox', checked: cfg.lines[key] ? 'checked' : null });
      cb.onchange = () => { cfg.lines[key] = cb.checked; if (extra) extra.classList.toggle('hide', !cb.checked); draw(); };
      return el('div', { class: 'qs-line' }, el('label', { class: 'qs-check' }, cb, el('span', { text: label })), extra || null);
    };
    const ti = el('input', { class: 'input', maxlength: '120', value: cfg.title || album.title || '', 'aria-label': t('qs_line_name') });
    ti.oninput = () => { cfg.title = ti.value.trim() && ti.value.trim() !== album.title ? ti.value : null; draw(); };
    const cu = el('textarea', { class: 'input', rows: '2', maxlength: '200', placeholder: t('qs_custom_ph'), 'aria-label': t('qs_line_custom') });
    cu.value = cfg.custom || '';
    cu.oninput = () => { cfg.custom = cu.value; draw(); };
    if (!cfg.lines.name) ti.classList.add('hide');
    if (!cfg.lines.custom) cu.classList.add('hide');
    ctrls.appendChild(section(t('qs_text'),
      check('name', t('qs_line_name'), ti),
      check('share', `${t('qs_line_share_label')} — ${t('qs_line_share')}`),
      check('custom', t('qs_line_custom'), cu),
      el('div', { class: 'muted', style: 'font-size:12.5px;margin-top:4px', text: t('qs_lines_hint') })));
    ctrls.appendChild(section(t('qs_font'), fgrid));

    const save = el('button', { class: 'btn btn-primary' }, t('save'));
    save.onclick = async () => {
      save.disabled = true;
      const r = await saveSign(album.id, cfg);
      save.disabled = false;
      if (!r.ok) { toast(r.error?.message || t('qs_save_failed')); return; }
      toast(r.local ? t('qs_saved_local') : t('qs_saved'));
      onSaved?.(normalize(cfg));
      ro.disconnect(); close();
    };
    ctrls.appendChild(el('div', { class: 'qs-actions' },
      el('div', { class: 'muted', style: 'font-size:12.5px;line-height:1.45', text: t('qs_print_hint') }),
      el('div', { class: 'rowx' }, el('button', { class: 'btn btn-ghost', onclick: () => { ro.disconnect(); close(); } }, t('cancel')), save)));

    requestAnimationFrame(draw);
  }, { wide: true });
}

/* ------------------------------------------------------------ стили */

let cssDone = false;
function injectCss() {
  if (cssDone) return; cssDone = true;
  document.head.appendChild(el('style', { text: CSS }));
}

const CSS = `
.qs{position:relative;overflow:hidden;background:var(--bg);color:var(--ink);font-family:Inter,system-ui,sans-serif;
  box-sizing:border-box;transform-origin:0 0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.qs *{box-sizing:border-box}
.qs-deco{position:absolute;inset:0;pointer-events:none}
.qs-deco>svg{position:absolute;left:0;top:0}
.qs-inner{position:relative;height:100%;display:flex;flex-direction:column;align-items:center;text-align:center;padding:78px 70px 44px}
.qs-h .qs-inner{flex-direction:row;align-items:center;justify-content:space-between;gap:56px;padding:64px 78px;text-align:left}
.qs-left{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;height:100%}
.qs-text{width:100%}
.qs{font-synthesis:none}
.qs-title{margin:0;font-family:var(--ff);font-size:calc(var(--tsize) * var(--wf,1));line-height:1.12;font-weight:var(--fw);overflow-wrap:anywhere;color:var(--ink)}
.qs-f-sans .qs-title{letter-spacing:-.02em}
.qs-title,.qs-sub,.qs-custom{text-wrap:balance}
.qs-g-ko .qs-title,.qs-g-ko .qs-sub,.qs-g-ko .qs-custom{word-break:keep-all;overflow-wrap:break-word}
.qs-g-ja .qs-title,.qs-g-sc .qs-title{line-break:strict;letter-spacing:.02em}
.qs-f-script .qs-title{line-height:1.2}
.qs-custom{margin:12px 0 0;font-family:var(--ff);font-weight:var(--fw2);font-size:calc(21px * var(--k) * var(--wf,1));line-height:1.4;color:var(--ink);opacity:.72;white-space:pre-line;overflow-wrap:anywhere}
.qs-rule{display:flex;align-items:center;justify-content:center;gap:10px;margin:22px auto 18px;width:220px}
.qs-h .qs-rule{margin:22px 0 18px;justify-content:flex-start}
.qs-rule i{flex:1;height:1.5px;background:var(--acc)}
.qs-rule b{width:9px;height:9px;transform:rotate(45deg);background:var(--acc)}
.qs-sub{margin:0;font-family:var(--ff);font-weight:var(--fw2);font-size:calc(26px * var(--k) * var(--wf,1));line-height:1.35;color:var(--ink);opacity:.85;overflow-wrap:anywhere}
.qs-h .qs-sub{font-size:calc(25px * var(--k) * var(--wf,1))}
.qs-measure .qs-title,.qs-measure .qs-sub,.qs-measure .qs-custom{overflow-wrap:normal!important;word-break:normal!important}
.qs-code{display:flex;flex-direction:column;align-items:center;margin-top:auto;margin-bottom:auto}
.qs-v .qs-code{margin-top:34px;margin-bottom:0}
.qs-card{background:#fff;border-radius:26px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.10);line-height:0}
.qs-card svg{display:block}
.qs-brand{margin-top:auto;padding-top:18px;font-family:'Cormorant Garamond',Georgia,serif;font-weight:700;font-size:24px;color:var(--acc);letter-spacing:.02em}
.qs-h .qs-brand{margin-top:34px}
.qs-v .qs-inner{justify-content:center;padding-bottom:96px}
.qs-v .qs-brand{position:absolute;left:0;right:0;bottom:44px;margin:0;padding:0}
.qs-photo{position:relative;width:100%;height:var(--ph);border-radius:22px;overflow:hidden;margin:-18px 0 36px;box-shadow:0 8px 26px rgba(0,0,0,.12);flex:none}
.qs-h .qs-photo{margin:0 0 30px}
.qs-photo img{display:block}
.qs-v.qs-has-photo .qs-inner{padding-top:62px}
.qs-v.qs-has-photo .qs-rule{margin:16px auto 12px}
.qs-v.qs-has-photo .qs-code{margin-top:26px}

/* plain */
.qs-plain .qs-card{box-shadow:none;border:1.5px solid #E6E1D6}
/* flowers */
.qs-fl{position:absolute;width:250px;height:233px}
.qs-fl-a{left:-30px;top:-28px}
.qs-fl-b{right:-30px;bottom:-28px;left:auto;top:auto;transform:rotate(180deg)}
.qs-h .qs-fl{width:220px;height:205px}
.qs-flowers .qs-card{box-shadow:0 10px 30px rgba(120,60,70,.12)}
.qs-v.qs-flowers .qs-inner{padding-top:180px}
.qs-v.qs-flowers.qs-has-photo .qs-inner{padding-top:120px}
.qs-h.qs-flowers .qs-inner{padding:64px 96px}
/* moon */
.qs-moon{background:radial-gradient(120% 80% at 70% 0%, color-mix(in srgb,var(--bg) 78%,#fff) 0%, var(--bg) 55%, color-mix(in srgb,var(--bg) 70%,#000) 100%)}
.qs-moon .qs-card{box-shadow:0 0 0 6px color-mix(in srgb,var(--acc) 35%,transparent),0 18px 50px rgba(0,0,0,.45)}
/* splash */
.qs-splash .qs-title{color:var(--ink)}
.qs-splash .qs-card{box-shadow:0 14px 40px color-mix(in srgb,var(--acc) 25%,transparent)}
/* neon */
.qs-neon{background:radial-gradient(90% 60% at 50% 40%, color-mix(in srgb,var(--bg) 85%,var(--acc)) 0%, var(--bg) 70%)}
.qs-neon-frame{position:absolute;inset:26px;border:3px solid var(--acc);border-radius:34px;
  box-shadow:0 0 6px var(--acc),0 0 18px var(--acc),0 0 40px color-mix(in srgb,var(--acc) 60%,transparent),inset 0 0 18px color-mix(in srgb,var(--acc) 50%,transparent)}
.qs-neon .qs-title{text-shadow:0 0 4px #fff,0 0 14px var(--acc),0 0 32px var(--acc)}
.qs-neon .qs-rule i,.qs-neon .qs-rule b{box-shadow:0 0 8px var(--acc)}
.qs-neon .qs-card{box-shadow:0 0 0 3px var(--acc),0 0 22px var(--acc),0 0 50px color-mix(in srgb,var(--acc) 50%,transparent)}
.qs-neon .qs-brand{font-family:Inter,system-ui,sans-serif;font-weight:800;font-size:20px;letter-spacing:.18em;text-transform:uppercase;text-shadow:0 0 10px var(--acc)}
/* gold */
.qs-frame1{position:absolute;inset:26px;border:2px solid var(--acc)}
.qs-frame2{position:absolute;inset:36px;border:.8px solid var(--acc)}
.qs-corner{position:absolute;width:86px;height:86px;color:var(--acc)}
.qs-corner.qs-tl{left:16px;top:16px}
.qs-corner.qs-tr{right:16px;top:16px;left:auto;transform:scaleX(-1)}
.qs-corner.qs-br{right:16px;bottom:16px;left:auto;top:auto;transform:scale(-1,-1)}
.qs-corner.qs-bl{left:16px;bottom:16px;top:auto;transform:scaleY(-1)}
.qs-gold .qs-card{box-shadow:0 0 0 1.5px var(--acc),0 0 0 7px var(--bg),0 0 0 8px var(--acc)}
.qs-gold .qs-inner{padding:96px 92px 62px}
.qs-h.qs-gold .qs-inner{padding:76px 100px}
/* water */
.qs-water .qs-card{box-shadow:0 12px 34px rgba(80,100,130,.16)}
/* dark */
.qs-dark .qs-card{border-radius:20px;box-shadow:none}
.qs-dark .qs-rule{width:64px}.qs-dark .qs-rule b{display:none}
.qs-dark .qs-brand{font-family:Inter,system-ui,sans-serif;font-weight:700;font-size:16px;letter-spacing:.24em;text-transform:uppercase}
.qs-dark .qs-title{letter-spacing:-.03em}

/* печать */
#qs-print{display:none}
@media print{
  html,body{margin:0!important;padding:0!important;height:100%!important;overflow:hidden!important;background:none!important}
  body>*:not(#qs-print){display:none!important}
  #qs-print{display:block!important;position:fixed;inset:0;overflow:hidden;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  #qs-print .qs{transform:none!important;position:absolute;left:0;top:0}
}

.qs-plain{width:100%;height:100%;box-sizing:border-box;padding:24mm;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12mm;background:#fff;color:#141414;font-family:Inter,system-ui,sans-serif;text-align:center}
.qs-plain h1{margin:0;font-size:34px;line-height:1.2;font-weight:700;max-width:100%;overflow-wrap:anywhere}
.qs-plain-brand{font-size:14px;letter-spacing:.08em;color:#8A8578}
@media print{#qs-print.qs-print-plain{background:#fff}}

/* превью и скачивание */
.qs-preview{position:relative;width:100%;overflow:hidden;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,.14);background:#F2EEE6}
.qs-preview>.qs{position:absolute;left:0;top:0;transform-origin:0 0}
.qs-dl-modal{max-width:420px}
.qs-dl-opts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}
.qs-dl-opt{display:flex;flex-direction:column;gap:4px;align-items:flex-start;text-align:left;padding:14px;border-radius:14px;border:1.5px solid #E6E1D6;background:#FBF9F5;cursor:pointer;font:inherit;color:var(--ink,#222)}
.qs-dl-opt:hover:not(:disabled){border-color:#C9A227}
.qs-dl-opt:disabled{opacity:.55;cursor:default}
.qs-dl-opt b{font-size:17px}.qs-dl-opt span{font-size:13px;color:var(--muted);line-height:1.35}
.qs-dl-status{min-height:20px;margin-top:12px;font-size:14px}

/* окно редактора */
.modal.qs-modal{max-width:1120px;padding:22px 24px 20px;max-height:94vh;display:flex;flex-direction:column;overflow:hidden}
.qs-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.qs-head h2{margin:0}
.qs-body{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,.9fr);gap:24px;min-height:0;flex:1}
.qs-view{background:#EFEBE3;border-radius:16px;display:flex;align-items:center;justify-content:center;padding:18px;min-height:0;height:min(76vh,760px)}
.qs-stage{position:relative;flex:none;box-shadow:0 10px 30px rgba(40,30,15,.18)}
.qs-stage>.qs{position:absolute;left:0;top:0}
.qs-ctrls{overflow:auto;min-height:0;max-height:min(76vh,760px);padding-right:4px}
.qs-sec{margin-bottom:18px}
.qs-sec .label{margin-bottom:8px}
.qs-seg{display:inline-flex;background:#F2EEE6;border-radius:999px;padding:3px}
.qs-seg button{border:0;background:transparent;border-radius:999px;padding:8px 16px;font:inherit;font-size:14px;font-weight:600;color:var(--muted);cursor:pointer}
.qs-seg button.on{background:#fff;color:var(--ink);box-shadow:0 1px 4px rgba(0,0,0,.1)}
.qs-designs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.qs-dtile{border:1.5px solid #E6E1D6;background:#fff;border-radius:12px;padding:6px;cursor:pointer;font:inherit;text-align:center}
.qs-dtile.on{border-color:var(--gold, #C9A227);box-shadow:0 0 0 2px rgba(201,162,39,.25)}
.qs-dt-sw{display:flex;align-items:center;justify-content:center;gap:6px;height:42px;border-radius:8px;background:var(--bg);color:var(--ink);position:relative;overflow:hidden}
.qs-dt-sw i{width:12px;height:12px;border-radius:50%;background:var(--acc)}
.qs-dt-sw b{font-family:'Cormorant Garamond',Georgia,serif;font-size:20px}
.qs-dt-neon .qs-dt-sw i{box-shadow:0 0 8px var(--acc)}
.qs-dt-gold .qs-dt-sw{box-shadow:inset 0 0 0 3px var(--bg),inset 0 0 0 4px var(--acc)}
.qs-dt-name{display:block;font-size:12px;font-weight:600;margin-top:5px;line-height:1.2;color:var(--ink, #141414)}
.qs-dtile .qs-dt-name{color:#3a352c}
.qs-swatches{display:flex;flex-wrap:wrap;gap:8px}
.qs-sw{width:40px;height:40px;border-radius:50%;border:1.5px solid #E0DACD;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:3px;padding:0}
.qs-sw i,.qs-sw b{width:10px;height:10px;border-radius:50%;display:block}
.qs-sw.on{box-shadow:0 0 0 3px rgba(201,162,39,.45);border-color:#C9A227}
.qs-sw:first-child{position:relative}
.qs-sw:first-child::after{content:'★';position:absolute;top:-4px;right:-4px;font-size:11px;color:#C9A227}
.qs-fonts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px}
.qs-font{border:1.5px solid #E6E1D6;background:#fff;border-radius:10px;padding:6px 4px;cursor:pointer;font:inherit;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0}
.qs-font b{line-height:1.25;color:#2a2620;height:34px;display:flex;align-items:center}
.qs-font span{font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.qs-font.on{border-color:#C9A227;box-shadow:0 0 0 2px rgba(201,162,39,.25)}
.qs-line{margin-bottom:10px}
.qs-line .input{margin-top:6px}
.qs-line textarea.input{height:auto;padding:10px 14px}
.qs-check{display:flex;gap:8px;align-items:center;font-size:14.5px;cursor:pointer}
.qs-colors{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px}
.qs-color{display:flex;align-items:center;gap:6px;font-size:13.5px;cursor:pointer}
.qs-color input{width:34px;height:30px;border:1px solid #E0DACD;border-radius:8px;padding:2px;background:#fff;cursor:pointer}
.qs-ph{position:relative}
.qs-badge{position:absolute;left:3px;bottom:3px;background:rgba(0,0,0,.62);color:#fff;font-size:10.5px;line-height:1;padding:3px 5px;border-radius:5px;font-weight:600;pointer-events:none}
.qs-ph-up{border:1.5px dashed var(--line,#ccc)!important;font-size:12.5px;font-weight:600;color:var(--ink,#222)}
.qs-photo-foot{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;margin-top:8px;font-size:13px;line-height:1.35}
.qs-adjust{flex:none}
.qs-crop-modal{max-width:600px}
.qs-crop{position:relative;overflow:hidden;margin:0 auto;border-radius:14px;cursor:grab;touch-action:none;background:#222;user-select:none}
.qs-crop:active{cursor:grabbing}
.qs-crop img{position:absolute;max-width:none;pointer-events:none}
.qs-zoom{display:flex;align-items:center;gap:12px;margin:14px 0 4px;font-size:14px}
.qs-zoom input{flex:1}
.qs-crop-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.qs-photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:6px;max-height:160px;overflow:auto}
.qs-ph{aspect-ratio:1;border-radius:10px;border:1.5px solid #E6E1D6;overflow:hidden;padding:0;background:#F2EEE6;cursor:pointer;font:inherit;font-size:12px;font-weight:600;color:var(--muted)}
.qs-ph img{width:100%;height:100%;object-fit:cover;display:block}
.qs-ph.on{border-color:#C9A227;box-shadow:0 0 0 2px rgba(201,162,39,.4)}
.qs-actions{position:sticky;bottom:0;background:var(--surface);padding-top:12px;border-top:1px solid #EFEBE3;display:flex;flex-direction:column;gap:10px}
.qs-actions .rowx{justify-content:flex-end}
@media (max-width:820px){
  .modal-bg:has(.qs-modal),body.has-mobnav .modal-bg:has(.qs-modal){padding:0;align-items:stretch}
  body.has-mobnav .modal.qs-modal{margin:0}
  .modal.qs-modal{max-height:none;height:100%;border-radius:0;padding:14px 14px 12px}
  .qs-body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr);gap:12px}
  .qs-view{height:38vh;padding:10px}
  .qs-ctrls{max-height:none}
  .qs-designs{grid-template-columns:repeat(4,minmax(0,1fr))}
  .qs-fonts{grid-template-columns:repeat(4,minmax(0,1fr))}
}
`;
