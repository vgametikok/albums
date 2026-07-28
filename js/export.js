// Выгрузка альбома одним архивом.
//
// Обещание «альбом остаётся вашим» ничего не стоит, пока его нельзя забрать.
// Здесь оно исполняется буквально: все оригиналы, голосовые заметки и обложка
// складываются в ZIP по главам, рядом кладётся album.txt с подписями — чтобы
// через десять лет было понятно, что на кадрах, даже без Albums.
//
// Ссылки на R2 живут 5–15 минут, поэтому подписываем не всё разом, а пачками
// прямо перед скачиванием: на архиве в несколько гигабайт первые ссылки успели
// бы протухнуть до того, как дойдёт очередь до последних файлов.
import { el, signUrls, resignUrl, modal, toast, t } from './ui.js';
import { createZip } from './zip.js';

const BATCH = 24;

const EXT_BY_KIND = { photo: 'jpg', image: 'jpg', video: 'mp4', audio: 'm4a' };

/** Расширение из пути в хранилище; если его там нет — по типу медиа. */
function extOf(path, kind) {
  const m = String(path || '').match(/\.([A-Za-z0-9]{1,5})(?:$|[?#])/);
  return (m ? m[1] : EXT_BY_KIND[kind] || 'bin').toLowerCase();
}

/** Кусок имени файла из произвольного текста: без переводов строк и не длиннее 60. */
function slice(text, max = 60) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

const pad = (n, w = 4) => String(n).padStart(w, '0');

/**
 * План архива: что скачать и как назвать. Порядок — тот же, что видит зритель,
 * поэтому нумерация файлов совпадает с порядком кадров в альбоме.
 */
export function planArchive(d) {
  const a = d.album || {};
  const files = [];
  const add = (path, name) => { if (path) files.push({ path, name }); };

  if (a.cover_path) add(a.cover_path, `cover.${extOf(a.cover_path, 'photo')}`);

  let n = 0;
  const section = (media, folder) => {
    for (const m of [...(media || [])].sort((x, y) => (x.position ?? 0) - (y.position ?? 0))) {
      n++;
      const cap = slice(m.caption);
      const base = cap ? `${pad(n)} ${cap}` : pad(n);
      add(m.path, `${folder}${base}.${extOf(m.path, m.kind)}`);
      // Голос к кадру — отдельным файлом рядом, с тем же номером.
      if (m.voice_path) add(m.voice_path, `${folder}${base} (voice).${extOf(m.voice_path, 'audio')}`);
    }
  };

  const chapters = d.chapters || [];
  chapters.forEach((c, i) => {
    const title = slice(c.title, 50);
    section(c.media, `${pad(i + 1, 2)}${title ? ' ' + title : ''}/`);
  });

  // Кадры вне глав. Пока глав нет — просто в корень, иначе отдельной папкой.
  section(d.loose, chapters.length ? `${pad(chapters.length + 1, 2)} ${t('more')}/` : '');

  // Голосовые к галереям не привязаны к конкретному кадру — им своя папка.
  (d.galleries || []).forEach((g, i) => {
    if (g.voice_path) add(g.voice_path, `voice/gallery ${pad(i + 1, 2)}.${extOf(g.voice_path, 'audio')}`);
  });

  return files;
}

/** album.txt: содержание альбома словами, чтобы архив читался и без Albums. */
function summaryText(d, failed) {
  const a = d.album || {}, author = d.author || {};
  const L = [];
  L.push(a.title || 'Album');
  L.push('='.repeat((a.title || 'Album').length));
  L.push('');
  if (author.name || author.username) L.push(`${t('ex_author')}: ${author.name || author.username}`);
  if (a.published_at) L.push(`${t('ex_date')}: ${new Date(a.published_at).toLocaleDateString()}`);
  L.push(`${t('ex_exported')}: ${new Date().toLocaleString()}`);
  L.push('');
  if (a.description) { L.push(a.description); L.push(''); }

  const textsBy = new Map();
  for (const x of (d.texts || [])) {
    const k = x.chapter_id || '';
    if (!textsBy.has(k)) textsBy.set(k, []);
    textsBy.get(k).push(x);
  }

  let n = 0;
  const section = (media, texts) => {
    const blocks = [
      ...(media || []).map(m => ({ pos: m.position ?? 0, m })),
      ...(texts || []).map(x => ({ pos: x.position ?? 0, x })),
    ].sort((p, q) => p.pos - q.pos);
    for (const b of blocks) {
      if (b.x) { L.push(''); L.push(b.x.body || ''); L.push(''); continue; }
      n++;
      L.push(`${pad(n)}  ${b.m.caption || '—'}${b.m.voice_path ? `  [${t('ex_has_voice')}]` : ''}`);
    }
  };

  (d.chapters || []).forEach((c, i) => {
    L.push('');
    L.push(`${pad(i + 1, 2)}. ${c.title || ''}`.trim());
    if (c.body) L.push(c.body);
    section(c.media, textsBy.get(c.id) || []);
  });
  if ((d.loose || []).length) {
    L.push('');
    L.push(t('more'));
    section(d.loose, textsBy.get('') || []);
  }

  if (failed.length) {
    L.push('');
    L.push(t('ex_missing'));
    failed.forEach(f => L.push(`  ${f}`));
  }
  L.push('');
  L.push('— albums.ink');
  return L.join('\r\n');   // CRLF: архив чаще всего открывают на Windows
}

/** Скачивание одного файла с переподписью ссылки при осечке. */
async function grab(path, urls) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = attempt === 0 ? urls[path] : await resignUrl(path);
    if (url) {
      try {
        const resp = await fetch(url);
        if (resp.ok) return await resp.blob();
      } catch (_) { /* сеть моргнула — пробуем ещё раз со свежей подписью */ }
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
  }
  return null;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Имя самого .zip: убираем только то, что запрещено в именах файлов Windows.
// Пробелы и дефисы остаются — «Две недели в Лиссабоне.zip» читается лучше.
const safeFileName = (s) => (String(s).replace(/[\\/:*?"<>|]/g, '').trim() || 'album');

/**
 * Собрать и отдать архив альбома. `d` — ответ RPC get_album.
 * Возвращает true, если файл ушёл на скачивание.
 */
export async function downloadAlbumArchive(d) {
  const files = planArchive(d);
  if (!files.length) { toast(t('ex_nothing')); return false; }

  let cancelled = false;
  let done = 0;
  const failed = [];

  const counter = el('div', { class: 'muted', style: 'font-size:14px;margin-top:6px' });
  const bar = el('i', { style: 'display:block;height:100%;width:0;background:var(--accent);border-radius:inherit;transition:width .2s' });
  const paint = () => {
    counter.textContent = `${done} / ${files.length}`;
    bar.style.width = `${Math.round(done / files.length * 100)}%`;
  };

  const close = modal((box, closeModal) => {
    box.append(
      el('h2', { text: t('ex_title') }),
      el('p', { class: 'muted', style: 'margin:0 0 14px', text: t('ex_hint') }),
      el('div', { style: 'height:8px;border-radius:4px;background:var(--line);overflow:hidden' }, bar),
      counter,
      el('button', {
        class: 'btn btn-ghost', style: 'width:100%;margin-top:18px',
        onclick: () => { cancelled = true; closeModal(); },
      }, t('cancel')),
    );
  });
  paint();

  const zip = createZip();
  try {
    for (let i = 0; i < files.length && !cancelled; i += BATCH) {
      const chunk = files.slice(i, i + BATCH);
      const urls = await signUrls(chunk.map(f => f.path));
      for (const f of chunk) {
        if (cancelled) break;
        const blob = await grab(f.path, urls);
        if (blob) await zip.add(f.name, blob);
        else failed.push(f.name);
        done++;
        paint();
      }
    }
  } catch (e) {
    close();
    toast(t('ex_failed'));
    return false;
  }

  if (cancelled) return false;

  await zip.add('album.txt', new Blob([summaryText(d, failed)], { type: 'text/plain;charset=utf-8' }));
  const archive = zip.finish();
  close();

  if (!zip.count || zip.count === 1) { toast(t('ex_failed')); return false; }

  saveBlob(archive, `${safeFileName(d.album?.title)}.zip`);
  toast(failed.length ? t('ex_done_partial').replace('{count}', failed.length) : t('ex_done'));
  return true;
}
