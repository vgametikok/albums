// paddle-webhook — приём оплат Paddle Billing (событийный альбом + подписка Pro).
//
// Единственный маршрут: POST от самого Paddle (notification destination
// ntfset_… в кабинете Paddle). verify_jwt=false — Paddle JWT не шлёт.
// Весь код в одном файле: tools/deploy-fn.ps1 заливает только index.ts.
//
// ИНВАРИАНТЫ БЕЗОПАСНОСТИ:
//   1. Тело обрабатывается ТОЛЬКО после проверки заголовка Paddle-Signature
//      (ts=…;h1=…, HMAC-SHA256 от "ts:сырое_тело" секретом PADDLE_WEBHOOK_SECRET).
//      Нет секрета — всё отвергаем.
//   2. Что куплено — ТОЛЬКО по id цены (pri_…) из таблицы PRICES для текущей
//      среды, плюс сверка суммы/валюты самой цены. custom_data.tier от клиента
//      — лишь подсказка: при расхождении верим цене и пишем в лог.
//   3. Кому — custom_data.user_id (его кладёт наш фронт в Checkout.open);
//      для событий подписки запасной путь — владелец из paypal_subscriptions.
//   4. Идемпотентность: event_id (evt_…) пишется в paypal_events после успешной
//      обработки; кредит события — paypal_grant_event по id транзакции (txn_…),
//      повтор — no-op. transaction.paid и transaction.completed одной покупки
//      дают ОДИН кредит.
//   5. Подписка — та же paypal_apply_sub, что у PayPal (статусы приводим к её
//      словарю: ACTIVE / CANCELLED / SUSPENDED / PAST_DUE). Новая миграция не нужна.
//
// Ответы: 2xx — событие принято (или сознательно пропущено); любой не-2xx
// Paddle повторит (sandbox — 3 раза за ~15 мин, live — до 3 суток).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Среда и каталог ─────────────────────────────────────────────────────────
// Переключатель: PADDLE_ENV=sandbox (по умолчанию) | live. Цены sandbox и live
// — разные сущности с разными id; live заполнить перед переключением.
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
    // заполнить id живых цен (node tools/paddle-setup.mjs с PADDLE_ENV=live)
  },
};
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

// ── Зависимости (в тестах подменяются) ──────────────────────────────────────
export interface Deps {
  env: 'sandbox' | 'live';
  secret: string;
  now(): number;                                              // секунды
  seen(eventId: string): Promise<boolean>;
  markSeen(eventId: string, type: string): Promise<void>;
  grantEvent(orderId: string, uid: string, tier: Tier): Promise<void>;
  applySub(subId: string, uid: string, status: string, periodEnd: string | null): Promise<void>;
  subOwner(subId: string): Promise<string | null>;
  log(...a: unknown[]): void;
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

async function onTransaction(d: Deps, data: any) {
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
  if (cd.tier && cd.tier !== grants[0]) d.log('paddle: custom_data.tier differs from price', txn, cd.tier, grants[0]);

  for (let i = 0; i < grants.length; i++) {
    await d.grantEvent(i === 0 ? txn : `${txn}#${i + 1}`, uid, grants[i]);
  }
  return { granted: grants };
}

async function onSubscription(d: Deps, data: any) {
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
  const status = subStatus(String(data?.status ?? ''));
  const periodEnd = data?.current_billing_period?.ends_at ?? data?.next_billed_at ?? null;
  await d.applySub(subId, uid, status, periodEnd);
  return { sub: subId, status };
}

export async function handle(req: Request, d: Deps): Promise<Response> {
  if (req.method !== 'POST') return res(405, { error: 'method' });
  const raw = await req.text();
  const sig = req.headers.get('paddle-signature') ?? '';
  if (!raw || !sig) return res(400, { error: 'missing_signature_or_body' });
  if (!(await verifySignature(sig, raw, d.secret, d.now()))) return res(401, { error: 'bad_signature' });

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
    return res(200, { ok: true, ...out });
  } catch (e) {
    d.log('paddle: process error', type, eventId, e instanceof Error ? e.message : e);
    return res(500, { error: 'process' });   // Paddle повторит; событие не помечено
  }
}

// ── Боевые зависимости: Supabase под сервисным ключом ──────────────────────
function liveDeps(): Deps {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } });
  const env = (Deno.env.get('PADDLE_ENV') ?? 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
  return {
    env,
    secret: Deno.env.get('PADDLE_WEBHOOK_SECRET') ?? '',
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
    // Как grantEvent в paypal-webhook: кредит (идемпотентно по order_id) + тариф в paypal_orders.
    async grantEvent(orderId, uid, tier) {
      const g = await sb.rpc('paypal_grant_event', { p_order_id: orderId, p_user_id: uid });
      if (g.error) throw new Error('grant: ' + g.error.message);
      const T = EVENT_TIERS[tier];
      const kind = 'event_' + tier;
      const full = await sb.from('paypal_orders')
        .update({ kind, tier, guest_cap: T.guests, storage_gb: T.gb, amount: T.price })
        .eq('order_id', orderId);
      if (full.error) {   // 053 ещё не применена — пишем хотя бы kind
        const k = await sb.from('paypal_orders').update({ kind }).eq('order_id', orderId);
        if (k.error) console.error('tier kind', orderId, k.error.message);
      }
    },
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
