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

import { cp, rm, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log(`dist: ${copied.length} entries`);
console.log(copied.sort().join(' '));
