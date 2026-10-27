// Источник первого визита: referrer (только внешний), utm_* и посадочная
// страница — в localStorage; после первого входа один раз уходит в базу через
// RPC set_signup_source (миграция 061). Всё молча: нет RPC/хранилища — не беда.
const KEY = 'albums_first_touch';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; }
}
function write(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* приватный режим */ }
}

function externalReferrer() {
  const r = document.referrer || '';
  if (!r) return '';
  try {
    const h = new URL(r).hostname.toLowerCase();
    const me = location.hostname.toLowerCase();
    if (h === me || h.endsWith('.albums.ink') || h === 'albums.ink') return '';
  } catch (_) { return ''; }
  return r.slice(0, 300);
}

/** Запоминает первый визит, если ещё не запомнен. Дёшево, безопасно звать на каждой странице. */
export function captureFirstTouch() {
  try {
    if (read()) return;
    const q = new URLSearchParams(location.search);
    const utm = {};
    for (const [k, v] of q) if (/^utm_[a-z_]{1,25}$/i.test(k) && v) utm[k.toLowerCase()] = v.slice(0, 100);
    // Служебные параметры входа в посадочный адрес не кладём.
    for (const k of ['code', 'state', 'error', 'error_description', 'access_token', 'token']) q.delete(k);
    const qs = q.toString();
    write({
      ref: externalReferrer(),
      utm,
      landing: (location.pathname + (qs ? '?' + qs : '')).slice(0, 300),
      ts: new Date().toISOString(),
      sent: false,
    });
  } catch (_) { /* не мешаем странице */ }
}

/** После входа: один раз отдаёт first touch в профиль. Любые сбои — молча (повтор при следующем визите). */
export async function sendFirstTouch(sb) {
  try {
    const ft = read();
    if (!ft || ft.sent) return;
    const { data, error } = await sb.rpc('set_signup_source', {
      p_referrer: ft.ref || null,
      p_utm: ft.utm && Object.keys(ft.utm).length ? ft.utm : null,
      p_landing: ft.landing || null,
    });
    if (error) return; // в т.ч. RPC ещё не создана — попробуем в следующий раз
    ft.sent = true;
    ft.stored = data === true;
    write(ft);
  } catch (_) { /* молча */ }
}

captureFirstTouch();
