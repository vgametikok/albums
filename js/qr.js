// QR-код общего альбома. Рисуем в SVG, а не в canvas: код печатают на табличке
// у входа в зал, и вектор одинаково чёток и на экране телефона, и на бумаге.
//
// Уровень коррекции ошибок H (восстанавливает до 30% данных) выбран не ради
// мятой бумаги, а потому что в центре кода мы закрываем модули плашкой
// «ALBUMS.INK». Закрытая площадь — около 7% кода, то есть с запасом меньше
// лимита даже с учётом того, что коррекция считается по блокам, а не по площади.
import qrcode from './vendor/qrcode.js';

const NS = 'http://www.w3.org/2000/svg';

// Ниже версии 5 (37×37) не опускаемся: на крупных модулях центральная плашка
// съедает слишком заметную долю кода, а её пропорции начинают гулять от
// округления. Ссылки приглашений всё равно длинные, floor срабатывает редко.
const MIN_TYPE = 5;

/**
 * @param text     что кодируем (ссылка приглашения)
 * @param size     сторона картинки в CSS-пикселях
 * @param quiet    ширина светлого поля в модулях (стандарт требует 4)
 * @param label    подпись в центре; пустая строка — рисовать чистый код
 * @returns {SVGSVGElement}
 */
export function qrSvg(text, size = 240, quiet = 4, label = 'ALBUMS.INK') {
  let qr = qrcode(0, 'H');              // 0 = подобрать версию по объёму данных
  qr.addData(text);
  qr.make();
  if (qr.getModuleCount() < 17 + 4 * MIN_TYPE) {
    qr = qrcode(MIN_TYPE, 'H');
    qr.addData(text);
    qr.make();
  }

  const n = qr.getModuleCount();
  const total = n + quiet * 2;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');

  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(total));
  bg.setAttribute('height', String(total));
  bg.setAttribute('fill', '#fff');
  svg.appendChild(bg);

  // Плашка строится ОТ ТЕКСТА, а не наоборот: сначала ширина под надпись
  // (textLength ниже прижмёт шрифтовые различия к этой ширине точно), от неё —
  // размер шрифта и высота. Так надпись читается целиком при любой генерации.
  const boxW = label ? Math.min(n - 8, Math.max(13, Math.round(n * 0.46))) : 0;
  const fontSize = boxW ? (boxW - 3) / 6.6 : 0;       // ~6.6em — ширина «ALBUMS.INK» жирным
  const boxH = label ? Math.max(4, Math.round(fontSize * 1.85)) : 0;
  const boxX = quiet + (n - boxW) / 2;
  const boxY = quiet + (n - boxH) / 2;

  // Модули не рисуем и под плашкой, и в зазоре вокруг неё: чистое поле отделяет
  // рамку от точек кода, иначе она сливается с ними в кашу.
  const pad = 0.5;      // белые поля плашки за рамкой
  const gap = 0.9;      // чистый зазор между рамкой и модулями кода
  const clr = pad + gap;
  const covered = (r, c) => label
    && c + quiet + 1 > boxX - clr && c + quiet < boxX + boxW + clr
    && r + quiet + 1 > boxY - clr && r + quiet < boxY + boxH + clr;

  // Одним path вместо тысячи <rect>: узел легче и печатается без швов между
  // соседними модулями.
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c) && !covered(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#141414');
  svg.appendChild(path);

  if (label) {
    const plate = document.createElementNS(NS, 'rect');
    plate.setAttribute('x', String(boxX - pad));
    plate.setAttribute('y', String(boxY - pad));
    plate.setAttribute('width', String(boxW + pad * 2));
    plate.setAttribute('height', String(boxH + pad * 2));
    plate.setAttribute('rx', String((boxH + pad * 2) * 0.24));
    plate.setAttribute('fill', '#fff');
    plate.setAttribute('stroke', '#141414');
    plate.setAttribute('stroke-width', '0.35');
    plate.setAttribute('shape-rendering', 'geometricPrecision');
    svg.appendChild(plate);

    const txt = document.createElementNS(NS, 'text');
    txt.setAttribute('x', String(quiet + n / 2));
    txt.setAttribute('y', String(quiet + n / 2));
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('dominant-baseline', 'central');
    // Шрифт не задаём именем: SVG уезжает в файл и в печать, где Inter может
    // не оказаться. textLength прижимает надпись к плашке точно в любом шрифте.
    txt.setAttribute('font-family', 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif');
    txt.setAttribute('font-size', String(fontSize));
    txt.setAttribute('font-weight', '700');
    txt.setAttribute('textLength', String(boxW - 3));
    txt.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    txt.setAttribute('fill', '#141414');
    txt.setAttribute('shape-rendering', 'geometricPrecision');
    txt.textContent = label;
    svg.appendChild(txt);
  }

  return svg;
}

/** Тот же QR отдельным файлом — чтобы отправить в чат или отдать в печать. */
export function qrDownload(text, filename = 'album-qr.svg', size = 1024) {
  const svg = qrSvg(text, size);
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
