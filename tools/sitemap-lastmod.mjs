/**
 * lastmod для sitemap.xml.
 *
 * Правило: если исходник страницы не менялся относительно origin/main —
 * оставляем lastmod из sitemap на origin/main (не бампим «оптом» на дату
 * сборки). Если менялся или URL новый — берём дату последнего git-коммита
 * по файлу, иначе сегодня.
 *
 * mtime после writeFile всегда «сегодня», поэтому его нельзя использовать.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export function gitLastmod(root, relFile) {
  if (!relFile) return null;
  try {
    const d = execFileSync('git', ['log', '-1', '--format=%cs', '--', relFile], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  } catch {
    return null;
  }
}

/** Файл отличается от ref (рабочее дерево + индекс) или ещё не в git. */
export function changedSince(root, relFile, ref = 'origin/main') {
  if (!relFile) return true;
  try {
    const diff = execFileSync('git', ['diff', '--name-only', ref, '--', relFile], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (diff) return true;
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', relFile], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return !!untracked;
  } catch {
    return true;
  }
}

export function parseLastmods(xml) {
  const map = new Map();
  for (const m of String(xml).matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

/** База: origin/main → HEAD → диск. */
export async function loadBaselineLastmods(root) {
  for (const ref of ['origin/main:sitemap.xml', 'HEAD:sitemap.xml']) {
    try {
      const xml = execFileSync('git', ['show', ref], {
        cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const map = parseLastmods(xml);
      if (map.size) return map;
    } catch { /* ref отсутствует */ }
  }
  try {
    return parseLastmods(await readFile(join(root, 'sitemap.xml'), 'utf8'));
  } catch {
    return new Map();
  }
}

/**
 * Неизменённый относительно origin/main → lastmod с main.
 * Изменённый/новый → git-дата файла, иначе сегодня.
 */
export function pickLastmod(root, relFile, prevMap, loc) {
  if (!changedSince(root, relFile) && loc && prevMap?.has(loc)) {
    return prevMap.get(loc);
  }
  return gitLastmod(root, relFile) || todayUTC();
}
