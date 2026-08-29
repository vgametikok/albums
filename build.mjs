/**
 * Сборка каталога для публикации (Cloudflare Pages: `node build.mjs`, вывод — dist).
 *
 * Раздача статики переехала с GitHub Pages, где список «не публиковать» жил в
 * _config.yml (Jekyll). Здесь та же задача решается копированием: в dist
 * попадает только то, что действительно должно лежать на albums.ink, а схема
 * БД, деплой-скрипты и внутренние документы остаются в репозитории.
 *
 * Список исключений держим в согласии с _config.yml — пока сайт умеет
 * собираться обоими способами, они должны прятать одно и то же.
 */

import { cp, rm, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'dist');

// Перед раскладкой — прошивка SEO-блоков и генерация sitemap.xml.
// Скрипт идемпотентен: правит только блок между <!-- seo --> … <!-- /seo -->.
await import('./tools/build-head.mjs');

// Не публикуем. Всё, что начинается с точки, отсекается отдельно ниже.
const SKIP = new Set([
  'dist',           // результат прошлой сборки
  'functions',      // Pages Functions: их забирает Cloudflare из корня репозитория
  'supabase',       // схема БД, RLS-политики, edge-функции
  'tools',          // деплой-скрипты
  'internal',       // приватные документы (лежат в отдельном репозитории)
  'Design',         // макеты редизайна (зипы Claude Design) — не для сайта
  'node_modules',
  'vendor',
  'serve.js',       // локальный дев-сервер
  'build.mjs',
  'README.md',
  '_config.yml',    // конфиг Jekyll, самому сайту не нужен
  'CNAME',          // домен настраивается в панели Cloudflare
  'Gemfile',
  'Gemfile.lock',
  'package.json',
  'package-lock.json',
]);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const entries = await readdir(ROOT, { withFileTypes: true });
const copied = [];

for (const e of entries) {
  if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
  await cp(join(ROOT, e.name), join(OUT, e.name), { recursive: true });
  copied.push(e.isDirectory() ? `${e.name}/` : e.name);
}

await stampVersion();

console.log(`dist: ${copied.length} entries`);
console.log(copied.sort().join(' '));

/**
 * Приписывает ?v=<хэш> ко всем своим скриптам и стилям — только в dist,
 * исходники остаются чистыми (и `node serve.js` работает как раньше).
 *
 * Зачем. Всё раздаётся с Cache-Control: max-age=600, а HTML и модули
 * кэшируются независимо. После выкладки браузер мог взять НОВЫЙ index.html
 * и СТАРЫЕ js/i18n/*.js — и на странице вместо подписей появлялись имена
 * ключей (hi_sign_names), потому что в старом словаре их ещё нет. Ждать
 * десять минут после каждого деплоя — не ответ.
 *
 * Хэш общий на всю сборку: файлы всегда выкладываются вместе, и один общий
 * номер versии проще и надёжнее, чем отдельный у каждого файла (иначе
 * пришлось бы переписывать импорты в порядке зависимостей).
 */
async function stampVersion() {
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else files.push(p);
    }
  };
  await walk(OUT);

  const code = files.filter(p => /\.(js|css)$/.test(p)).sort();
  const h = createHash('sha256');
  for (const p of code) h.update(await readFile(p));
  const v = h.digest('hex').slice(0, 8);

  // Импорты с https:// (CDN) не трогаем: у них своя версия в пути.
  const stampJs = (s) => s
    .replace(/(from\s*['"])(\.\.?\/[^'"]+?\.js)(['"])/g, `$1$2?v=${v}$3`)
    .replace(/(import\(\s*['"])(\.\.?\/[^'"]+?\.js)(['"])/g, `$1$2?v=${v}$3`)
    // шаблонный импорт словаря: import(`./i18n/${lang}.js`)
    .replace(/(import\(\s*`\.\/i18n\/\$\{lang\}\.js)(`)/g, `$1?v=${v}$2`);

  const stampHtml = (s) => s
    .replace(/(<script[^>]+src=")((?:js|src)\/[^"]+?\.js)(")/g, `$1$2?v=${v}$3`)
    .replace(/(<link[^>]+href=")(css\/[^"]+?\.css)(")/g, `$1$2?v=${v}$3`);

  let touched = 0;
  for (const p of files) {
    if (/\.js$/.test(p)) {
      const src = await readFile(p, 'utf8');
      const out = stampJs(src);
      if (out !== src) { await writeFile(p, out); touched++; }
    } else if (/\.html$/.test(p)) {
      const src = await readFile(p, 'utf8');
      const out = stampHtml(src);
      if (out !== src) { await writeFile(p, out); touched++; }
    }
  }
  console.log(`version ${v}: проштамповано файлов — ${touched}`);
}
