// paddle-webhook — приём оплат Paddle Billing (событийный альбом + подписка Pro).
//
// Единственный маршрут: POST от самого Paddle (notification destination
// ntfset_… в кабинете Paddle). verify_jwt=false — Paddle JWT не шлёт.
// Весь код в одном файле: tools/deploy-fn.ps1 заливает только index.ts.
//
// ИНВАРИАНТЫ БЕЗОПАСНОСТИ:
//   1. Тело обрабатывается ТОЛЬКО после проверки заголовка Paddle-Signature
//      (ts=…;h1=…, HMAC-SHA256 от "ts:сырое_тело" секретом среды:
//      PADDLE_WEBHOOK_SECRET_LIVE или PADDLE_WEBHOOK_SECRET для sandbox, см. п. 0).
//      Нет ни одного подходящего секрета — отвергаем (401).
//   2. Что куплено — ТОЛЬКО по id цены (pri_…) из таблицы PRICES для текущей
//      среды, плюс сверка суммы/валюты самой цены. custom_data.tier от клиента
//      — лишь подсказка: при расхождении верим цене и пишем в лог.
//   3. Кому — custom_data.user_id (его кладёт наш фронт в Checkout.open);
//      для событий подписки запасной путь — владелец из paypal_subscriptions.
//   4. Идемпотентность: event_id (evt_…) пишется в paypal_events после успешной
//      обработки; кредит события — paypal_grant_event_tier (миграция 054: кредит
//      и тариф одной транзакцией; до неё — paypal_grant_event) по id транзакции (txn_…),
//      повтор — no-op. transaction.paid и transaction.completed одной покупки
//      дают ОДИН кредит.
//   0. ОДНА ФУНКЦИЯ — ОБЕ СРЕДЫ. Среду события определяет подпись: сначала
//      пробуем секрет live-destination (PADDLE_WEBHOOK_SECRET_LIVE), затем
//      sandbox (PADDLE_WEBHOOK_SECRET). Совпал live — цены PRICES.live, IP из
//      api.paddle.com/ips, выдача всем; совпал sandbox — PRICES.sandbox, IP из
//      sandbox-api.paddle.com/ips, выдача только по списку почт (п. 5).
//      Цена чужой среды в событии не находится в таблице и ничего не выдаёт.
//   5. SANDBOX НЕ ДАЁТ НАСТОЯЩИХ ПОКУПОК ЧУЖИМ: для sandbox-событий выдача
//      (кредит события и Pro) — только пользователям, чья почта в
//      PADDLE_SANDBOX_ALLOW_EMAILS (через запятую). Пустой список — никому.
//      Иначе тестовой картой 4242… любой получил бы альбом/Pro бесплатно.
//      Ролей админа в базе нет (админка — логин/пароль mod-api), поэтому только список.
//   6. Подписка — та же paypal_apply_sub, что у PayPal (статусы приводим к её
//      словарю: ACTIVE / CANCELLED / SUSPENDED / PAST_DUE). Новая миграция не нужна.
//   7. IP-фильтр (вторая линия после подписи): доставку принимаем только с
//      адресов Paddle из {API}/ips для среды, чья подпись совпала
//      (data.ipv4_cidrs; live — api.paddle.com, sandbox — sandbox-api.paddle.com),
//      список кэшируется в памяти на час.
//      Чужой адрес — 403. Список получить не удалось, или платформа не дала
//      адрес клиента, — работаем по одной подписи и пишем в лог (выдачу не
//      ломаем). Адрес клиента — первый элемент X-Forwarded-For (так его
//      отдаёт Supabase Edge; см. clientIp()), запасные — CF-Connecting-IP,
//      X-Real-IP. PADDLE_IP_CHECK=enforce (по умолчанию) | log | off.
//   8. Paddle ID покупателя (data.customer_id, ctm_…) сохраняется для Paddle
//      Retain (pwCustomer на фронте) — paddle_set_customer из миграции 056.
//      Ошибка записи (в т.ч. миграция не применена) выдачу не ломает.
//
// СЕКРЕТЫ ФУНКЦИИ: PADDLE_WEBHOOK_SECRET_LIVE (ntfset_01m3tf9ththmc2sgx0bdvdhecf),
//   PADDLE_WEBHOOK_SECRET (sandbox, ntfset_01m3gnwtyntx8d1dxejt7q64q6),
//   PADDLE_SANDBOX_ALLOW_EMAILS, PADDLE_IP_CHECK (enforce|log|off).
//   Нет секрета среды — её события отвергаются (401). PADDLE_ENV больше не нужен.
//
// Ответы: 2xx — событие принято (или сознательно пропущено); любой не-2xx
// Paddle повторит (sandbox — 3 раза за ~15 мин, live — до 3 суток).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Среды и каталог ─────────────────────────────────────────────────────────
// Цены sandbox и live — разные сущности с разными id (те же, что в js/paddle-config.js).
export type Env = 'sandbox' | 'live';
export type Tier = 'small' | 'medium' | 'large';
type PriceDef = { kind: 'event'; tier: Tier; amount: string } | { kind: 'pro'; amount: string };
export const PRICES: Record<'sandbox' | 'live', Record<string, PriceDef>> = {
  sandbox: {
    pri_01m3gnwsayjfzvgq7hed8zwxp3: { kind: 'event', tier: 'small', amount: '3999' },
    pri_01m3gnwsnp6pqcceja5wd0zdvt: { kind: 'event', tier: 'medium', amount: '6999' },
    pri_01m3gnwt653y0fyj0gqwxaf64m: { kind: 'event', tier: 'large', amount: '12999' },
    pri_01m3gnwtebq6mfe1fybbcy4hqr: { kind: 'pro', amount: '999' },
  },
  live: {
    pri_01m3tf9j4sanm5rcxx38h4dvj7: { kind: 'event', tier: 'small', amount: '3999' },    // pro_01m3tf9j232fh6gvyvd06mdd2e
    pri_01m3tf9jbpehws199xd225gwww: { kind: 'event', tier: 'medium', amount: '6999' },   // pro_01m3tf9j9753n0j7txnwah3wt6
    pri_01m3tf9jk0p2d5mmwgj0my8hmg: { kind: 'event', tier: 'large', amount: '12999' },   // pro_01m3tf9jg3tfv16xwxtbabjr09
    pri_01m3tf9jtgj1ne0rzqm3bgxbp3: { kind: 'pro', amount: '999' },                      // pro_01m3tf9jqny7sdf3azwsajxvhk
  },
};
/** Базовый URL Paddle API для среды (для /ips и любых будущих вызовов API). */
export const API_BASE: Record<'sandbox' | 'live', string> = {
  sandbox: 'https://sandbox-api.paddle.com',
  live: 'https://api.paddle.com',
};
export const ipsUrl = (env: 'sandbox' | 'live') => `${API_BASE[env]}/ips`;

export const EVENT_TIERS: Record<Tier, { guests: number; gb: number; price: number }> = {
  small:  { guests: 100, gb: 100, price: 39.99 },
  medium: { guests: 250, gb: 200, price: 69.99 },
  large:  { guests: 500, gb: 400, price: 129.99 },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOLERANCE_S = 300;   // старше 5 минут подпись не принимаем (повтор Paddle подписывает заново)

// ── Подпись ─────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
function hex(buf: ArrayBuffer) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
/** Paddle-Signature: "ts=1671552777;h1=abc…" (h1 может быть несколько при ротации секрета). */
export async function verifySignature(header: string, raw: string, secret: string, nowS: number) {
  if (!secret || !header) return false;
  let ts = '';
  const h1: string[] = [];
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    const v = rest.join('=');
    if (k === 'ts') ts = v;
    else if (k === 'h1' && v) h1.push(v.toLowerCase());
  }
  if (!/^\d+$/.test(ts) || !h1.length) return false;
  if (Math.abs(nowS - Number(ts)) > TOLERANCE_S) return false;
  const want = await hmacHex(secret, `${ts}:${raw}`);
  return h1.some(s => safeEqual(s, want));
}

// ── IP-фильтр ───────────────────────────────────────────────────────────────
function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(x => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}
/** IPv4 в одном из CIDR (a.b.c.d/nn или голый адрес). IPv6 и мусор — false. */
export function ipInCidrs(ip: string, cidrs: string[]): boolean {
  let a = ip.trim();
  if (a.startsWith('::ffff:')) a = a.slice(7);            // IPv4-mapped IPv6
  const n = ipv4ToInt(a);
  if (n === null) return false;
  for (const c of cidrs) {
    const [base, bitsS] = String(c).trim().split('/');
    const b = ipv4ToInt(base);
    const bits = bitsS === undefined ? 32 : Number(bitsS);
    if (b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

/**
 * Адрес отправителя за прокси Supabase Edge. Supabase в своих примерах
 * (edge-functions location, cloudflare-turnstile) берёт первый элемент
 * X-Forwarded-For — это адрес, с которого пришёл запрос. Запасные:
 * CF-Connecting-IP (ставит Cloudflare), X-Real-IP. Возвращает и источник —
 * он пишется в лог, чтобы по первой доставке было видно, чем мы пользуемся.
 */
export function clientIp(h: Headers): { ip: string; via: string } | null {
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return { ip: first, via: 'x-forwarded-for' };
  }
  for (const k of ['cf-connecting-ip', 'x-real-ip']) {
    const v = h.get(k)?.trim();
    if (v) return { ip: v, via: k };
  }
  return null;
}

/**
 * Список адресов Paddle с кэшем в памяти изолята. null — получить не
 * удалось (тогда вызывающий работает по одной подписи). Неудачу повторяем
 * не чаще раза в минуту, чтобы не долбить API при каждой доставке.
 */
export function makeIpList(url: string, fetchFn: typeof fetch = fetch, nowMs: () => number = Date.now,
  ttlMs = 60 * 60 * 1000, retryMs = 60 * 1000) {
  let cidrs: string[] | null = null;
  let until = 0;
  let inflight: Promise<string[] | null> | null = null;
  return async (): Promise<string[] | null> => {
    if (nowMs() < until) return cidrs;
    return (inflight ||= (async () => {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        let r: Response;
        try { r = await fetchFn(url, { signal: ctl.signal }); } finally { clearTimeout(timer); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const list = (j?.data?.ipv4_cidrs ?? []).map(String).filter((c: string) => ipv4ToInt(c.split('/')[0]) !== null);
        if (!list.length) throw new Error('empty ipv4_cidrs');
        cidrs = list;
        until = nowMs() + ttlMs;
      } catch (e) {
        // Прошлый удачный список (если был) продолжаем использовать; нет — null.
        until = nowMs() + retryMs;
        console.error('paddle: IP list fetch failed', url, e instanceof Error ? e.message : e);
      } finally {
        inflight = null;
      }
      return cidrs;
    })());
  };
}

// ── Зависимости (в тестах подменяются) ──────────────────────────────────────
export interface Deps {
  /** Секреты notification destination по средам; пустой — события среды отвергаются. */
  secrets: Partial<Record<Env, string>>;
  sandboxAllow: string[];                                     // почты в нижнем регистре
  userEmail(uid: string): Promise<string | null>;
  now(): number;                                              // секунды
  seen(eventId: string): Promise<boolean>;
  markSeen(eventId: string, type: string): Promise<void>;
  grantEvent(orderId: string, uid: string, tier: Tier): Promise<void>;
  applySub(subId: string, uid: string, status: string, periodEnd: string | null): Promise<void>;
  subOwner(subId: string): Promise<string | null>;
  log(...a: unknown[]): void;
  /** Разрешённые CIDR Paddle для среды; null — список недоступен. Нет функции — фильтр выключен. */
  ipAllow?(env: Env): Promise<string[] | null>;
  /** enforce (по умолчанию) — чужой IP получает 403; log — только пишем; off — не проверяем. */
  ipCheck?: 'enforce' | 'log' | 'off';
  /** Сохранить Paddle ID покупателя для Retain (не должен бросать). */
  setCustomer?(uid: string, env: Env, customerId: string): Promise<void>;
}

/** Зависимости + среда, определённая подписью текущей доставки. */
type Ctx = Deps & { env: Env };

/** Какой средой подписана доставка: live первым (боевые деньги), затем sandbox. */
export async function signedEnv(header: string, raw: string, d: Deps): Promise<Env | null> {
  for (const env of ['live', 'sandbox'] as const) {
    const sec = d.secrets[env];
    if (sec && await verifySignature(header, raw, sec, d.now())) return env;
  }
  return null;
}

const res = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/** Статус подписки Paddle -> словарь paypal_apply_sub. */
export function subStatus(s: string): string {
  switch (s) {
    case 'active':
    case 'trialing': return 'ACTIVE';      // Pro до конца оплаченного периода (+сутки запаса)
    case 'past_due': return 'PAST_DUE';    // профиль не трогаем: Pro доживает plan_until, пока Paddle повторяет списание
    case 'paused':   return 'SUSPENDED';   // сразу free
    case 'canceled': return 'CANCELLED';   // профиль не трогаем: дослуживает оплаченный срок, снимет expire_plans()
    default:         return s.toUpperCase();
  }
}

export function parseAllow(v: string | undefined | null): string[] {
  return String(v ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

/** В sandbox — только для почт из списка. В live — всем. */
async function sandboxAllowed(d: Ctx, uid: string, ref: string): Promise<boolean> {
  if (d.env !== 'sandbox') return true;
  const email = (await d.userEmail(uid))?.trim().toLowerCase() ?? '';
  if (email && d.sandboxAllow.includes(email)) return true;
  d.log('paddle: SANDBOX purchase by non-allowlisted user — skipped', ref, uid);
  return false;
}

const CTM_RE = /^ctm_[a-z0-9]{26}$/;
/** Запомнить ctm_… покупателя; любые сбои — только в лог. */
async function rememberCustomer(d: Ctx, uid: string, data: any) {
  const ctm = String(data?.customer_id ?? '');
  if (!d.setCustomer || !CTM_RE.test(ctm)) return;
  try { await d.setCustomer(uid, d.env, ctm); } catch (e) {
    d.log('paddle: setCustomer failed', uid, e instanceof Error ? e.message : e);
  }
}

async function onTransaction(d: Ctx, data: any) {
  const status = String(data?.status ?? '');
  if (status !== 'paid' && status !== 'completed') return { skipped: 'status:' + status };
  const txn = String(data?.id ?? '');
  if (!txn.startsWith('txn_')) throw new Error('no transaction id');
  const cd = data?.custom_data ?? {};
  const uid = String(cd.user_id ?? '');
  const table = PRICES[d.env];

  const grants: Tier[] = [];
  for (const it of (data?.items ?? [])) {
    const price = it?.price ?? {};
    const def = table[String(price.id ?? '')];
    if (!def || def.kind !== 'event') continue;             // Pro (и чужие цены) — не здесь
    const up = price.unit_price ?? {};
    if (String(up.amount) !== def.amount || up.currency_code !== 'USD') {
      d.log('paddle: price terms mismatch', txn, price.id, up);
      continue;
    }
    const q = Math.max(1, Math.min(10, Number(it?.quantity) || 1));
    for (let i = 0; i < q; i++) grants.push(def.tier);
  }
  if (!grants.length) return { skipped: 'no_event_items' };

  if (!UUID_RE.test(uid)) {
    // Оплата без нашего user_id (не с нашего фронта). Не выдаём кредит вслепую;
    // 2xx, чтобы не жечь повторы, событие НЕ помечаем — можно переиграть вручную.
    d.log('paddle: UNMATCHED paid transaction (no user_id)', txn, data?.customer_id);
    return { unmatched: true, noMark: true };
  }
  if (!(await sandboxAllowed(d, uid, txn))) return { skipped: 'sandbox_not_allowed', noMark: true };
  if (cd.tier && cd.tier !== grants[0]) d.log('paddle: custom_data.tier differs from price', txn, cd.tier, grants[0]);

  for (let i = 0; i < grants.length; i++) {
    await d.grantEvent(i === 0 ? txn : `${txn}#${i + 1}`, uid, grants[i]);
  }
  await rememberCustomer(d, uid, data);
  return { granted: grants };
}

async function onSubscription(d: Ctx, data: any) {
  const subId = String(data?.id ?? '');
  if (!subId.startsWith('sub_')) throw new Error('no subscription id');
  const table = PRICES[d.env];
  const isPro = (data?.items ?? []).some((it: any) => table[String(it?.price?.id ?? '')]?.kind === 'pro');
  if (!isPro) return { skipped: 'not_pro' };

  let uid = String(data?.custom_data?.user_id ?? '');
  if (!UUID_RE.test(uid)) uid = (await d.subOwner(subId)) ?? '';
  if (!UUID_RE.test(uid)) {
    d.log('paddle: UNMATCHED subscription (no user_id)', subId, data?.customer_id);
    return { unmatched: true, noMark: true };
  }
  if (!(await sandboxAllowed(d, uid, subId))) return { skipped: 'sandbox_not_allowed', noMark: true };
  const status = subStatus(String(data?.status ?? ''));
  const periodEnd = data?.current_billing_period?.ends_at ?? data?.next_billed_at ?? null;
  await d.applySub(subId, uid, status, periodEnd);
  await rememberCustomer(d, uid, data);
  return { sub: subId, status };
}

/** IP-фильтр: Response(403) — отвергнуть; null — пропустить дальше (к подписи). */
async function checkIp(req: Request, d: Ctx): Promise<Response | null> {
  const mode = d.ipCheck ?? 'enforce';
  if (mode === 'off' || !d.ipAllow) return null;
  const who = clientIp(req.headers);
  if (!who) {
    d.log('paddle: no client IP header — signature-only');
    return null;
  }
  let list: string[] | null = null;
  try { list = await d.ipAllow(d.env); } catch (_) { list = null; }
  if (!list) {
    d.log('paddle: Paddle IP list unavailable — signature-only', d.env, who.ip);
    return null;
  }
  if (ipInCidrs(who.ip, list)) return null;
  d.log('paddle: delivery from non-Paddle IP', d.env, who.ip, 'via', who.via,
    { xff: req.headers.get('x-forwarded-for'), cf: req.headers.get('cf-connecting-ip'), real: req.headers.get('x-real-ip') },
    mode === 'enforce' ? '— rejected 403' : '— log only');
  return mode === 'enforce' ? res(403, { error: 'forbidden_ip' }) : null;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return res(405, { error: 'method' });
  const raw = await req.text();
  const sig = req.headers.get('paddle-signature') ?? '';
  if (!raw || !sig) return res(400, { error: 'missing_signature_or_body' });
  // Подпись первой: только она говорит, какая среда (и какой список IP) у доставки.
  const env = await signedEnv(sig, raw, deps);
  if (!env) return res(401, { error: 'bad_signature' });
  const d: Ctx = { ...deps, env };
  const denied = await checkIp(req, d);
  if (denied) return denied;

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return res(400, { error: 'bad_json' }); }
  const eventId = String(evt?.event_id ?? '');
  const type = String(evt?.event_type ?? '');
  if (!eventId || !type) return res(400, { error: 'bad_event' });

  try {
    if (await d.seen(eventId)) return res(200, { ok: true, dup: true });
    let out: any = { skipped: 'type' };
    if (type === 'transaction.paid' || type === 'transaction.completed') out = await onTransaction(d, evt.data);
    else if (type.startsWith('subscription.')) out = await onSubscription(d, evt.data);
    if (!out?.noMark) await d.markSeen(eventId, 'paddle:' + type);
    return res(200, { ok: true, env, ...out });
  } catch (e) {
    d.log('paddle: process error', type, eventId, e instanceof Error ? e.message : e);
    return res(500, { error: 'process' });   // Paddle повторит; событие не помечено
  }
}

// ── Запись кредита с тарифом ───────────────────────────────────────────────
// Такая же функция живёт в paypal-webhook (у каждой функции один файл).
/** Минимум клиента supabase-js, который нужен выдаче (в тестах — подделка). */
export interface GrantClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { code?: string; message: string } | null }>;
  from(table: string): {
    update(v: Record<string, unknown>): { eq(col: string, val: string): PromiseLike<{ error: { message: string } | null }> };
  };
}

/** Функции нет в схеме (миграция 054 ещё не применена). */
export function isMissingFn(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  return e.code === 'PGRST202' || e.code === '42883' || /could not find the function/i.test(e.message ?? '');
}

/**
 * Кредит события + тариф. С миграцией 054 — одной транзакцией в
 * paypal_grant_event_tier (строка заказа сразу с tier; повтор — no-op).
 * Без неё — прежний путь: paypal_grant_event из 040 и UPDATE тарифа
 * (колонки tier… из 053, а без 053 — хотя бы kind = event_<tier>).
 * Возвращает, каким путём записано: 'tier' | 'legacy'.
 */
export async function recordEventGrant(sb: GrantClient, orderId: string, uid: string, tier: Tier,
  log: (...a: unknown[]) => void = console.error): Promise<'tier' | 'legacy'> {
  const r = await sb.rpc('paypal_grant_event_tier', { p_order_id: orderId, p_user_id: uid, p_tier: tier });
  if (!r.error) return 'tier';
  if (!isMissingFn(r.error)) throw new Error('grant: ' + r.error.message);

  const g = await sb.rpc('paypal_grant_event', { p_order_id: orderId, p_user_id: uid });
  if (g.error) throw new Error('grant: ' + g.error.message);
  const T = EVENT_TIERS[tier];
  const kind = 'event_' + tier;
  const full = await sb.from('paypal_orders')
    .update({ kind, tier, guest_cap: T.guests, storage_gb: T.gb, amount: T.price })
    .eq('order_id', orderId);
  if (full.error) {   // 053 ещё не применена — пишем хотя бы kind
    const k = await sb.from('paypal_orders').update({ kind }).eq('order_id', orderId);
    if (k.error) log('tier kind', orderId, k.error.message);
  }
  return 'legacy';
}

// ── Боевые зависимости: Supabase под сервисным ключом ──────────────────────
function liveDeps(): Deps {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } });
  const ipMode = (Deno.env.get('PADDLE_IP_CHECK') ?? 'enforce').toLowerCase();
  const ipLists = { live: makeIpList(ipsUrl('live')), sandbox: makeIpList(ipsUrl('sandbox')) };
  return {
    secrets: {
      live: Deno.env.get('PADDLE_WEBHOOK_SECRET_LIVE') ?? '',
      sandbox: Deno.env.get('PADDLE_WEBHOOK_SECRET') ?? '',
    },
    ipCheck: ipMode === 'off' ? 'off' : ipMode === 'log' ? 'log' : 'enforce',
    ipAllow: (e) => ipLists[e](),
    async setCustomer(uid, e, ctm) {
      const r = await sb.rpc('paddle_set_customer', { p_user_id: uid, p_env: e, p_customer_id: ctm });
      if (r.error) {
        // До миграции 056 функции нет — не шумим каждую доставку ошибкой уровня error.
        if (isMissingFn(r.error)) console.warn('paddle: 056 not applied, customer id not stored');
        else console.error('paddle_set_customer', uid, r.error.message);
      }
    },
    sandboxAllow: parseAllow(Deno.env.get('PADDLE_SANDBOX_ALLOW_EMAILS')),
    async userEmail(uid) {
      const r = await sb.auth.admin.getUserById(uid);
      if (r.error) throw new Error('userEmail: ' + r.error.message);
      return r.data.user?.email ?? null;
    },
    now: () => Math.floor(Date.now() / 1000),
    async seen(id) {
      const r = await sb.from('paypal_events').select('event_id').eq('event_id', id).maybeSingle();
      if (r.error) throw new Error('seen: ' + r.error.message);
      return !!r.data;
    },
    async markSeen(id, type) {
      const r = await sb.from('paypal_events').insert({ event_id: id, event_type: type });
      if (r.error && r.error.code !== '23505') console.error('markSeen', id, r.error.message);
    },
    // Как grantEvent в paypal-webhook: кредит + тариф (идемпотентно по order_id).
    grantEvent: (orderId, uid, tier) => recordEventGrant(sb as unknown as GrantClient, orderId, uid, tier).then(() => {}),
    async applySub(subId, uid, status, periodEnd) {
      const r = await sb.rpc('paypal_apply_sub', {
        p_subscription_id: subId, p_user_id: uid, p_status: status, p_period_end: periodEnd,
      });
      if (r.error) throw new Error('apply_sub: ' + r.error.message);
    },
    async subOwner(subId) {
      const r = await sb.from('paypal_subscriptions').select('user_id').eq('subscription_id', subId).maybeSingle();
      return (r.data?.user_id as string) ?? null;
    },
    log: (...a) => console.error(...a),
  };
}

// В тестах (PADDLE_WEBHOOK_TEST=1) сервер не поднимаем — только экспорт handle().
if (Deno.env.get('PADDLE_WEBHOOK_TEST') !== '1') {
  const deps = liveDeps();
  Deno.serve((req) => handle(req, deps));
}
