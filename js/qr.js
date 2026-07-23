// QR-код общего альбома. Рисуем в SVG, а не в canvas: код печатают на табличке
// у входа в зал, и вектор одинаково чёток и на экране телефона, и на бумаге.
//
// Уровень коррекции ошибок M — компромисс: держит запачканный и слегка мятый
// отпечаток, но не раздувает сетку так, как H.
import qrcode from './vendor/qrcode.js';

/**
 * @param text     что кодируем (ссылка приглашения)
 * @param size     сторона картинки в CSS-пикселях
 * @param quiet    ширина светлого поля в модулях (стандарт требует 4)
 * @returns {SVGSVGElement}
 */
export function qrSvg(text, size = 240, quiet = 4) {
  const qr = qrcode(0, 'M');            // 0 = подобрать версию по объёму данных
  qr.addData(text);
  qr.make();

  const n = qr.getModuleCount();
  const total = n + quiet * 2;
  const NS = 'http://www.w3.org/2000/svg';

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

  // Одним path вместо тысячи <rect>: узел легче и печатается без швов между
  // соседними модулями.
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#141414');
  svg.appendChild(path);

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
