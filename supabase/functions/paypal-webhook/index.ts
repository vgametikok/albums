// paypal-webhook — автоматический приём подписки Pro через PayPal.
//
// Маршруты (роутинг по хвосту пути):
//   POST /create-subscription — наш фронт (apikey-гейт + JWT). Создаёт подписку в
//                               PayPal с custom_id = id пользователя, возвращает
//                               ссылку approve, куда фронт перенаправляет покупателя.
//   POST /webhook             — зовёт САМ PayPal. apikey он не шлёт, поэтому здесь
//                               аутентификация = проверка подписи вебхука у PayPal.
//
// verify_jwt=false: маршрут webhook вызывает PayPal без JWT; шлюз завернул бы его.
//
// ИНВАРИАНТЫ БЕЗОПАСНОСТИ:
//   1. Кто получил Pro — ТОЛЬКО из custom_id подписки, которую отдаёт сам PayPal
//      по GET (не из тела вебхука напрямую). custom_id проставляем мы при создании.
//   2. Смену plan делает RPC paypal_apply_sub под сервисным ключом — единственный,
//      кроме ручной выдачи, путь (триггер trg_profile_guard из 021).
//   3. /webhook обрабатывается лишь после verify-webhook-signature = SUCCESS.
//   4. Цена события — ТОЛЬКО из EVENT_TIERS на сервере. Клиент присылает лишь
//      название тарифа; сумму заказа, а после оплаты и захваченную сумму, мы
//      сверяем с таблицей тарифов. Не совпало — кредит не выдаём.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUBLISHABLE = Deno.env.get('SB_PUBLISHABLE_KEY') ?? '';

// Переключатель среды: sandbox (тест, фейковые деньги) или live (боевой).
const ENV = (Deno.env.get('PAYPAL_ENV') ?? 'sandbox').toLowerCase();
const LIVE = ENV === 'live';
const PP_BASE = LIVE ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const PP_CLIENT = (LIVE ? Deno.env.get('PAYPAL_CLIENT_ID') : Deno.env.get('PAYPAL_SANDBOX_CLIENT_ID')) ?? '';
const PP_SECRET = (LIVE ? Deno.env.get('PAYPAL_SECRET') : Deno.env.get('PAYPAL_SANDBOX_SECRET')) ?? '';
const PP_WEBHOOK_ID = (LIVE ? Deno.env.get('PAYPAL_WEBHOOK_ID') : Deno.env.get('PAYPAL_SANDBOX_WEBHOOK_ID')) ?? '';

const SITE = 'https://albums.ink';
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const ALLOW_ORIGINS = ['https://albums.ink', 'https://www.albums.ink', 'https://vgametikok.github.io', 'http://localhost:5085'];
function cors(origin: string | null) {
  const allow = origin && ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}
const json = (status: number, obj: unknown, h: Record<string, string>) =>
  new Response(JSON.stringify(obj), { status, headers: h });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Тарифы событийного альбома ──────────────────────────────────────────────
// Единственный источник цены. Витрина (/events/) показывает те же числа, но
// её цифрам сервер не верит: клиент шлёт только { tier }.
export type Tier = 'small' | 'medium' | 'large';
export const EVENT_TIERS: Record<Tier, { price: string; guests: number; gb: number; name: string }> = {
  small:  { price: '39.99',  guests: 100, gb: 100, name: 'Small' },
  medium: { price: '69.99',  guests: 250, gb: 200, name: 'Medium' },
  large:  { price: '129.99', guests: 500, gb: 400, name: 'Large' },
};
const isTier = (v: unknown): v is Tier => typeof v === 'string' && Object.hasOwn(EVENT_TIERS, v);
const REF_PREFIX = 'event_';   // reference_id заказа: event_small / event_medium / event_large

/** Тариф по сумме (USD). Для старых заказов без нашего reference_id и для вебхука. */
export function tierByAmount(value: unknown, currency: unknown): Tier | null {
  if (currency !== 'USD') return null;
  const v = Number(value);
  for (const k of Object.keys(EVENT_TIERS) as Tier[]) {
    if (Number(EVENT_TIERS[k].price) === v) return k;
  }
  return null;
}

/**
 * Тариф заказа по данным самого PayPal: reference_id, который мы проставили
 * при создании, обязан совпасть с суммой. Старые заказы (до тарифов) шли без
 * reference_id — для них тариф определяется суммой ($39.99 = small).
 */
export function tierOfUnit(pu: any): Tier | null {
  const amt = pu?.amount ?? {};
  const byAmount = tierByAmount(amt.value, amt.currency_code);
  const ref = String(pu?.reference_id ?? '');
  if (ref.startsWith(REF_PREFIX)) {
    const t = ref.slice(REF_PREFIX.length);
    return isTier(t) && byAmount === t ? t : null;
  }
  return byAmount;
}

// ── Запись кредита с тарифом ───────────────────────────────────────────────
// Такая же функция живёт в paddle-webhook (у каждой функции один файл).
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
 * Выдать кредит события и записать тариф. Идемпотентно по order_id.
 * С миграцией 054 — одной транзакцией в paypal_grant_event_tier (строка заказа
 * сразу с tier; повтор — no-op). Без неё — прежний путь: paypal_grant_event
 * из 040 и отдельный UPDATE тарифа (колонки tier… из 053, а без 053 — хотя бы
 * kind = event_<tier>). Возвращает, каким путём записано: 'tier' | 'legacy'.
 */
export async function recordEventGrant(db: GrantClient, orderId: string, uid: string, tier: Tier,
  log: (...a: unknown[]) => void = console.error): Promise<'tier' | 'legacy'> {
  const r = await db.rpc('paypal_grant_event_tier', { p_order_id: orderId, p_user_id: uid, p_tier: tier });
  if (!r.error) return 'tier';
  if (!isMissingFn(r.error)) throw new Error('grant: ' + r.error.message);

  const g = await db.rpc('paypal_grant_event', { p_order_id: orderId, p_user_id: uid });
  if (g.error) throw new Error('grant: ' + g.error.message);
  const T = EVENT_TIERS[tier];
  const kind = REF_PREFIX + tier;
  const full = await db.from('paypal_orders')
    .update({ kind, tier, guest_cap: T.guests, storage_gb: T.gb, amount: Number(T.price) })
    .eq('order_id', orderId);
  if (full.error) {
    // 053 ещё не применена — колонок нет; сохраняем хотя бы kind
    const k = await db.from('paypal_orders').update({ kind }).eq('order_id', orderId);
    if (k.error) log('tier kind', orderId, k.error.message);
  }
  return 'legacy';
}

const grantEvent = (orderId: string, uid: string, tier: Tier) =>
  recordEventGrant(sb as unknown as GrantClient, orderId, uid, tier);

// ── PayPal REST helpers ─────────────────────────────────────────────────────
async function ppToken(): Promise<string> {
  const r = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${PP_CLIENT}:${PP_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('paypal token ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return (await r.json()).access_token as string;
}

async function pp(token: string, path: string, method = 'GET', body?: unknown): Promise<any> {
  const r = await fetch(`${PP_BASE}${path}`, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`paypal ${method} ${path} ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Plan_id тарифа Albums Pro ($9.99/мес) для текущей среды. Создаём Product+Plan
// один раз и кладём в paypal_plans; дальше — из кэша. sandbox и live независимы.
async function ensurePlanId(token: string): Promise<string> {
  const { data: cached } = await sb.from('paypal_plans').select('plan_id').eq('env', ENV).maybeSingle();
  if (cached?.plan_id) return cached.plan_id;

  const product = await pp(token, '/v1/catalogs/products', 'POST', {
    name: 'Albums Pro',
    description: 'Albums Pro subscription — extra storage, original quality, analytics',
    type: 'SERVICE',
    category: 'SOFTWARE',
  });
  const plan = await pp(token, '/v1/billing/plans', 'POST', {
    product_id: product.id,
    name: 'Albums Pro Monthly',
    description: 'Albums Pro — monthly subscription',
    status: 'ACTIVE',
    billing_cycles: [{
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0, // 0 = бессрочно, до отмены
      pricing_scheme: { fixed_price: { value: '9.99', currency_code: 'USD' } },
    }],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: 'CONTINUE',
      payment_failure_threshold: 1,
    },
  });
  await sb.from('paypal_plans').insert({ env: ENV, product_id: product.id, plan_id: plan.id });
  return plan.id as string;
}

// Проверка подписи вебхука у самого PayPal. Без webhook_id (не зарегистрирован) —
// всегда провал, и это правильно: не обрабатываем непроверенное.
async function verifyWebhook(token: string, headers: Headers, rawBody: string): Promise<boolean> {
  if (!PP_WEBHOOK_ID) return false;
  const res = await pp(token, '/v1/notifications/verify-webhook-signature', 'POST', {
    transmission_id: headers.get('paypal-transmission-id'),
    transmission_time: headers.get('paypal-transmission-time'),
    cert_url: headers.get('paypal-cert-url'),
    auth_algo: headers.get('paypal-auth-algo'),
    transmission_sig: headers.get('paypal-transmission-sig'),
    webhook_id: PP_WEBHOOK_ID,
    webhook_event: JSON.parse(rawBody),
  });
  return res.verification_status === 'SUCCESS';
}

async function serve(req: Request): Promise<Response> {
  const origin = req.headers.get('origin');
  const h = cors(origin);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  if (req.method !== 'POST') return json(405, { error: 'method' }, h);

  const route = new URL(req.url).pathname.split('/').pop();

  // ─────────────────────── Вебхук от PayPal ───────────────────────
  if (route === 'webhook') {
    const raw = await req.text();
    let token: string;
    try { token = await ppToken(); } catch (e) { console.error('token', e); return json(500, { error: 'token' }, h); }

    let ok = false;
    try { ok = await verifyWebhook(token, req.headers, raw); } catch (e) { console.error('verify', e); }
    if (!ok) return json(401, { error: 'bad_signature' }, h);

    let evt: any;
    try { evt = JSON.parse(raw); } catch { return json(400, { error: 'bad_json' }, h); }

    // Уже обрабатывали? PayPal штатно шлёт повторы.
    const seen = await sb.from('paypal_events').select('event_id').eq('event_id', evt.id).maybeSingle();
    if (seen.data) return json(200, { ok: true, dup: true }, h);

    const type = String(evt.event_type ?? '');
    try {
      if (type.startsWith('BILLING.SUBSCRIPTION') || type === 'PAYMENT.SALE.COMPLETED') {
        // Подписка Pro. id: у SALE это billing_agreement_id, у BILLING — resource.id.
        const subId = evt.resource?.billing_agreement_id ?? evt.resource?.id;
        if (subId) {
          // истину о подписке берём напрямую у PayPal, а не из тела вебхука
          const sub = await pp(token, `/v1/billing/subscriptions/${subId}`);
          const uid = sub.custom_id;
          if (uid && UUID_RE.test(uid)) {
            await sb.rpc('paypal_apply_sub', {
              p_subscription_id: subId,
              p_user_id: uid,
              p_status: sub.status,
              p_period_end: sub.billing_info?.next_billing_time ?? null,
            });
          }
        }
      } else if (type === 'PAYMENT.CAPTURE.COMPLETED') {
        // Разовая оплата события (страховка к пути возврата capture-order):
        // custom_id эхом возвращается в capture-ресурсе, order_id — в related_ids.
        // Тариф — по захваченной сумме из проверенного события PayPal.
        const uid = evt.resource?.custom_id;
        const orderId = evt.resource?.supplementary_data?.related_ids?.order_id ?? evt.resource?.id;
        const tier = tierByAmount(evt.resource?.amount?.value, evt.resource?.amount?.currency_code);
        if (uid && UUID_RE.test(uid) && orderId) {
          if (tier) await grantEvent(orderId, uid, tier);
          else console.error('capture amount matches no tier', orderId, evt.resource?.amount);
        }
      }
    } catch (e) {
      // 500 -> PayPal повторит позже; событие НЕ помечаем обработанным
      console.error('process', type, e);
      return json(500, { error: 'process' }, h);
    }

    // помечаем обработанным (дубликат PK молча глотаем)
    await sb.from('paypal_events').insert({ event_id: evt.id, event_type: type });
    return json(200, { ok: true }, h);
  }

  // ─────────────────── Наши маршруты: apikey-гейт ───────────────────
  if (!PUBLISHABLE || req.headers.get('apikey') !== PUBLISHABLE) {
    return json(401, { error: 'bad_apikey' }, h);
  }
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  let viewer: string | null = null;
  if (bearer && bearer !== PUBLISHABLE) {
    try { viewer = (await sb.auth.getUser(bearer)).data.user?.id ?? null; } catch { viewer = null; }
  }

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* не все маршруты шлют тело */ }

  if (route === 'create-subscription') {
    if (!viewer) return json(401, { error: 'auth_required' }, h);
    try {
      const token = await ppToken();
      const planId = await ensurePlanId(token);
      const sub = await pp(token, '/v1/billing/subscriptions', 'POST', {
        plan_id: planId,
        custom_id: viewer, // так вебхук узнает, кому включать Pro
        application_context: {
          brand_name: 'Albums',
          user_action: 'SUBSCRIBE_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: `${SITE}/pro-thanks.html`,
          cancel_url: `${SITE}/pricing.html`,
        },
      });
      const approve = (sub.links ?? []).find((l: any) => l.rel === 'approve')?.href;
      if (!approve) return json(502, { error: 'no_approve_link' }, h);
      return json(200, { url: approve }, h);
    } catch (e) {
      console.error('create-sub', e);
      return json(502, { error: 'paypal_error' }, h);
    }
  }

  // Разовая оплата события: заказ на сумму выбранного тарифа, custom_id = uid.
  // Тело: { tier: 'small' | 'medium' | 'large' }; без tier — small (старый фронт).
  // В ответе эхо tier и amount: фронт сверяет их, прежде чем уводить на PayPal.
  if (route === 'create-order') {
    if (!viewer) return json(401, { error: 'auth_required' }, h);
    const tier = body?.tier ?? 'small';
    if (!isTier(tier)) return json(400, { error: 'bad_tier' }, h);
    const T = EVENT_TIERS[tier];
    try {
      const token = await ppToken();
      const order = await pp(token, '/v2/checkout/orders', 'POST', {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: REF_PREFIX + tier,
          custom_id: viewer,
          description: `Albums Event Album — ${T.name} (up to ${T.guests} guests, ${T.gb} GB)`,
          amount: { currency_code: 'USD', value: T.price },
        }],
        application_context: {
          brand_name: 'Albums',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: `${SITE}/event-thanks.html`,
          cancel_url: `${SITE}/events/#buy`,
        },
      });
      const approve = (order.links ?? []).find((l: any) => l.rel === 'approve')?.href;
      if (!approve) return json(502, { error: 'no_approve_link' }, h);
      return json(200, { url: approve, tier, amount: T.price, currency: 'USD' }, h);
    } catch (e) {
      console.error('create-order', e);
      return json(502, { error: 'paypal_error' }, h);
    }
  }

  // Захват платежа после одобрения (страница возврата шлёт order_id). Кредит
  // выдаём только тому, чей uid зашит в custom_id заказа. Идемпотентно.
  if (route === 'capture-order') {
    if (!viewer) return json(401, { error: 'auth_required' }, h);
    const orderId = String(body?.order_id ?? '').trim();
    if (!orderId) return json(400, { error: 'no_order' }, h);
    try {
      const token = await ppToken();
      const order = await pp(token, `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      const pu = order.purchase_units?.[0];
      if (pu?.custom_id !== viewer) {
        return json(403, { error: 'not_your_order' }, h);
      }
      // сумма заказа обязана совпасть с ценой тарифа — иначе не захватываем
      const tier = tierOfUnit(pu);
      if (!tier) {
        console.error('capture-order: amount/tier mismatch', orderId, pu?.reference_id, pu?.amount);
        return json(409, { error: 'amount_mismatch' }, h);
      }
      let status = order.status;
      let captured = (pu?.payments?.captures ?? [])[0]?.amount;
      if (status === 'APPROVED') {
        const cap = await pp(token, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, 'POST', {});
        status = cap.status;
        captured = cap.purchase_units?.[0]?.payments?.captures?.[0]?.amount ?? captured;
      }
      if (status === 'COMPLETED') {
        // и захваченная сумма — тоже (если PayPal её вернул)
        if (captured && tierByAmount(captured.value, captured.currency_code) !== tier) {
          console.error('capture-order: captured amount mismatch', orderId, captured);
          return json(409, { error: 'amount_mismatch' }, h);
        }
        await grantEvent(orderId, viewer, tier);
        return json(200, { ok: true, tier }, h);
      }
      return json(409, { error: 'not_completed', status }, h);
    } catch (e) {
      console.error('capture-order', e);
      return json(502, { error: 'paypal_error' }, h);
    }
  }

  return json(404, { error: 'not_found' }, h);
}

// В тестах (PAYPAL_WEBHOOK_TEST=1) сервер не поднимаем — только экспорт функций.
if (Deno.env.get('PAYPAL_WEBHOOK_TEST') !== '1') Deno.serve(serve);
