// Воронка лендинга /events: визиты и клики Buy → RPC landing_track (063).
// Ботов отсекаем на клиенте; сервер ещё раз режет rate/sanity. Ошибки RPC
// глотаем — отсутствие миграции или сети не должно ломать страницу.
import { sb } from './sb.js';

const SID_KEY = 'albums_lf_sid';
const VISIT_PREFIX = 'albums_lf_visit_'; // + YYYY-MM-DD (UTC)

const BOT_UA = /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|outbrain|pinterest|vkshare|w3c_validator|whatsapp|telegram|discord|preview|headless|phantom|selenium|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|yandex(?:bot|images|metrika)|google(?:bot|image|other|favicon)|applebot|semrush|ahrefs|mj12bot|dotbot|petalbot|bytespider/i;

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function sessionId() {
  try {
    let id = localStorage.getItem(SID_KEY);
    if (id && /^[A-Za-z0-9_-]{8,64}$/.test(id)) return id;
    id = (crypto.randomUUID && crypto.randomUUID().replace(/-/g, ''))
      || (`s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
    id = String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (id.length < 8) id = (id + 'xxxxxxxx').slice(0, 8);
    localStorage.setItem(SID_KEY, id);
    return id;
  } catch (_) {
    return null;
  }
}

/** Prefetch / prerender / Speculation Rules — не считаем визитом. */
function isPrefetchOrPrerender() {
  try {
    if (document.prerendering) return true;
    const bal = performance.getEntriesByType?.('navigation')?.[0];
    if (bal && (bal.type === 'prerender' || bal.deliveryType === 'navigational-prefetch')) return true;
  } catch (_) { /* ignore */ }
  // Chrome/Safari иногда ставят Sec-Purpose / Purpose через document — недоступно;
  // visibility hidden на старте + pageshow from bfcache обрабатываем отдельно.
  if (document.visibilityState === 'hidden' && document.prerendering !== false) {
    // только если явно prerendering; иначе hidden вкладка — ок, дождёмся visible
  }
  return false;
}

export function isLikelyBot() {
  try {
    if (navigator.webdriver) return true;
    const ua = navigator.userAgent || '';
    if (!ua || BOT_UA.test(ua)) return true;
    // нет языков / нулевой экран — типично для headless
    if (!navigator.languages || !navigator.languages.length) return true;
    if ((screen.width || 0) + (screen.height || 0) === 0) return true;
  } catch (_) {
    return true;
  }
  return false;
}

async function send(kind, tier) {
  if (isLikelyBot()) return false;
  const sid = sessionId();
  if (!sid) return false;
  try {
    const args = { p_kind: kind, p_session_id: sid };
    if (tier) args.p_tier = tier;
    const { error } = await sb.rpc('landing_track', args);
    if (error) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Один визит на браузер в UTC-день. Ждёт реальный показ страницы
 * (не prefetch/prerender): если документ ещё hidden — откладывает.
 */
export function trackLandingVisit() {
  const run = async () => {
    if (isPrefetchOrPrerender()) return;
    if (document.visibilityState === 'hidden') return;
    const day = utcDay();
    try {
      if (localStorage.getItem(VISIT_PREFIX + day) === '1') return;
    } catch (_) { /* private mode — всё равно пробуем серверный дедуп */ }
    // send() false = бот/нет sid; ошибка RPC тоже false. Успешный ответ
    // (в т.ч. серверный дедуп «уже есть») помечаем день локально.
    const sid = sessionId();
    if (!sid || isLikelyBot()) return;
    try {
      const { error } = await sb.rpc('landing_track', {
        p_kind: 'visit', p_session_id: sid,
      });
      if (error) return;
      try { localStorage.setItem(VISIT_PREFIX + day, '1'); } catch (_) { /* ignore */ }
    } catch (_) { /* ignore */ }
  };

  if (document.visibilityState === 'hidden' || isPrefetchOrPrerender()) {
    const onShow = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onShow);
      document.removeEventListener('pageshow', onShow);
      run();
    };
    document.addEventListener('visibilitychange', onShow);
    document.addEventListener('pageshow', onShow);
    // prerenderactivation (Chromium)
    document.addEventListener('prerenderingchange', onShow, { once: true });
    return;
  }
  // небольшой отложенный тик: отсекает мгновенный prefetch→discard
  setTimeout(run, 400);
}

/** Клик Buy по тарифу. Звать синхронно на pointerdown/click до ухода на PayPal. */
export function trackBuyClick(tier) {
  const t = String(tier || '').toLowerCase();
  if (!['small', 'medium', 'large', 'pro'].includes(t)) return;
  // fire-and-forget: не блокируем оплату
  void send('buy_click', t);
}

/**
 * Навешивает учёт кликов на кнопки с data-tier (и опционально id=pro-cta → pro).
 * capture:true — срабатывает до обработчика checkout.
 */
export function wireBuyClickTracking(root = document) {
  const handler = (ev) => {
    const btn = ev.target?.closest?.('[data-tier], #pro-cta, [data-landing-tier]');
    if (!btn || !root.contains(btn)) return;
    const tier = (btn.dataset.landingTier || btn.dataset.tier || (btn.id === 'pro-cta' ? 'pro' : '')).toLowerCase();
    if (tier) trackBuyClick(tier);
  };
  root.addEventListener('click', handler, true);
}
