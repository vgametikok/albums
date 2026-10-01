// Тесты paddle-webhook с подменёнными зависимостями (без сети и базы).
//   deno test --allow-env --allow-net supabase/functions/paddle-webhook/
// (--allow-net нужен только чтобы Deno скачал импорт supabase-js из index.ts)
import { assert, assertEquals } from 'jsr:@std/assert@1';

Deno.env.set('PADDLE_WEBHOOK_TEST', '1');
const m = await import('./index.ts');

const SECRET = 'pdl_ntfset_test_secret';
const NOW = 1_790_000_000;
const UID = '11111111-2222-4333-8444-555555555555';
const SMALL = 'pri_01m3gnwsayjfzvgq7hed8zwxp3';
const MEDIUM = 'pri_01m3gnwsnp6pqcceja5wd0zdvt';
const LARGE = 'pri_01m3gnwt653y0fyj0gqwxaf64m';
const PRO = 'pri_01m3gnwtebq6mfe1fybbcy4hqr';

function fakeDeps(over: Partial<any> = {}) {
  const calls = { grants: [] as any[], subs: [] as any[], marked: [] as string[], logs: [] as any[] };
  const seenSet = new Set<string>();
  const owned = new Map<string, string>();
  const d: any = {
    env: 'sandbox' as const, secret: SECRET, now: () => NOW,
    sandboxAllow: ['qa@albums.ink'],
    userEmail: async (u: string) => (u === UID ? 'QA@albums.ink' : 'stranger@example.com'),
    seen: async (id: string) => seenSet.has(id),
    markSeen: async (id: string) => { seenSet.add(id); calls.marked.push(id); },
    grantEvent: async (o: string, u: string, t: string) => { calls.grants.push([o, u, t]); },
    applySub: async (s: string, u: string, st: string, pe: string | null) => { calls.subs.push([s, u, st, pe]); owned.set(s, u); },
    subOwner: async (s: string) => owned.get(s) ?? null,
    log: (...a: unknown[]) => { calls.logs.push(a); },
    ...over,
  };
  // Среду теперь задаёт подпись: env/secret из теста превращаем в secrets.
  if (!(over as any).secrets) (d as any).secrets = { [d.env]: d.secret };
  return { d, calls, owned };
}

async function signed(body: unknown, opts: { ts?: number; secret?: string; header?: string } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const ts = opts.ts ?? NOW;
  const h1 = await m.hmacHex(opts.secret ?? SECRET, `${ts}:${raw}`);
  return new Request('https://x.supabase.co/functions/v1/paddle-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Paddle-Signature': opts.header ?? `ts=${ts};h1=${h1}` },
    body: raw,
  });
}

const txn = (over: any = {}) => ({
  event_id: 'evt_01aaa', event_type: 'transaction.completed', occurred_at: '2026-09-27T05:00:00Z',
  data: {
    id: 'txn_01abc', status: 'completed', customer_id: 'ctm_01x', subscription_id: null,
    custom_data: { user_id: UID, tier: 'medium', kind: 'event' },
    items: [{ quantity: 1, price: { id: MEDIUM, unit_price: { amount: '6999', currency_code: 'USD' } } }],
    ...over,
  },
});
const sub = (status: string, over: any = {}, type = 'subscription.updated') => ({
  event_id: 'evt_sub_' + status + type, event_type: type,
  data: {
    id: 'sub_01xyz', status, customer_id: 'ctm_01x',
    custom_data: { user_id: UID, kind: 'pro' },
    items: [{ quantity: 1, price: { id: PRO, unit_price: { amount: '999', currency_code: 'USD' } } }],
    current_billing_period: { starts_at: '2026-09-27T05:00:00Z', ends_at: '2026-10-27T05:00:00Z' },
    ...over,
  },
});

Deno.test('signature: valid, tampered, wrong secret, stale, missing, rotated', async () => {
  const raw = JSON.stringify(txn());
  const h1 = await m.hmacHex(SECRET, `${NOW}:${raw}`);
  assert(await m.verifySignature(`ts=${NOW};h1=${h1}`, raw, SECRET, NOW));
  assert(!(await m.verifySignature(`ts=${NOW};h1=${h1}`, raw + ' ', SECRET, NOW)));
  assert(!(await m.verifySignature(`ts=${NOW};h1=${h1}`, raw, 'other', NOW)));
  assert(!(await m.verifySignature(`ts=${NOW};h1=${h1}`, raw, SECRET, NOW + 301)));
  assert(!(await m.verifySignature(`ts=${NOW};h1=${h1}`, raw, '', NOW)));
  assert(!(await m.verifySignature(`h1=${h1}`, raw, SECRET, NOW)));
  assert(await m.verifySignature(`ts=${NOW};h1=deadbeef;h1=${h1}`, raw, SECRET, NOW));
});

Deno.test('rejects unsigned / badly signed requests with non-2xx and does nothing', async () => {
  const { d, calls } = fakeDeps();
  let r = await m.handle(new Request('https://x/', { method: 'POST', body: JSON.stringify(txn()) }), d);
  assertEquals(r.status, 400);
  r = await m.handle(await signed(txn(), { secret: 'wrong' }), d);
  assertEquals(r.status, 401);
  r = await m.handle(await signed(txn(), { ts: NOW - 1000 }), d);
  assertEquals(r.status, 401);
  r = await m.handle(new Request('https://x/', { method: 'GET' }), d);
  assertEquals(r.status, 405);
  assertEquals(calls.grants.length, 0);
  assertEquals(calls.marked.length, 0);
});

Deno.test('transaction.completed grants the tier from the PRICE id', async () => {
  const { d, calls } = fakeDeps();
  const r = await m.handle(await signed(txn()), d);
  assertEquals(r.status, 200);
  assertEquals(calls.grants, [['txn_01abc', UID, 'medium']]);
  assertEquals(calls.marked, ['evt_01aaa']);
});

Deno.test('each tier maps correctly', async () => {
  for (const [id, amount, tier] of [[SMALL, '3999', 'small'], [MEDIUM, '6999', 'medium'], [LARGE, '12999', 'large']]) {
    const { d, calls } = fakeDeps();
    const r = await m.handle(await signed(txn({ items: [{ quantity: 1, price: { id, unit_price: { amount, currency_code: 'USD' } } }] })), d);
    assertEquals(r.status, 200);
    assertEquals(calls.grants[0][2], tier);
  }
});

Deno.test('client custom_data.tier cannot upgrade: price id wins', async () => {
  const { d, calls } = fakeDeps();
  const body = txn({ custom_data: { user_id: UID, tier: 'large' },
    items: [{ quantity: 1, price: { id: SMALL, unit_price: { amount: '3999', currency_code: 'USD' } } }] });
  await m.handle(await signed(body), d);
  assertEquals(calls.grants, [['txn_01abc', UID, 'small']]);
  assert(calls.logs.some(l => String(l[0]).includes('differs')));
});

Deno.test('unknown price id or mismatched price terms grant nothing', async () => {
  const { d, calls } = fakeDeps();
  let r = await m.handle(await signed(txn({ items: [{ quantity: 1, price: { id: 'pri_01unknown', unit_price: { amount: '6999', currency_code: 'USD' } } }] })), d);
  assertEquals(r.status, 200);
  const e2 = txn({ items: [{ quantity: 1, price: { id: LARGE, unit_price: { amount: '100', currency_code: 'USD' } } }] });
  e2.event_id = 'evt_02';
  r = await m.handle(await signed(e2), d);
  assertEquals(r.status, 200);
  assertEquals(calls.grants.length, 0);
});

Deno.test('transaction.paid then transaction.completed: both call grant with the same txn id (SQL dedups)', async () => {
  const { d, calls } = fakeDeps();
  const paid = txn({ status: 'paid' }); paid.event_id = 'evt_paid'; paid.event_type = 'transaction.paid';
  await m.handle(await signed(paid), d);
  await m.handle(await signed(txn()), d);
  assertEquals(calls.grants.map(g => g[0]), ['txn_01abc', 'txn_01abc']);
});

Deno.test('duplicate event_id is acknowledged without reprocessing', async () => {
  const { d, calls } = fakeDeps();
  await m.handle(await signed(txn()), d);
  const r = await m.handle(await signed(txn()), d);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).dup, true);
  assertEquals(calls.grants.length, 1);
});

Deno.test('non-final transaction status is ignored', async () => {
  const { d, calls } = fakeDeps();
  const e = txn({ status: 'ready' });
  const r = await m.handle(await signed(e), d);
  assertEquals(r.status, 200);
  assertEquals(calls.grants.length, 0);
});

Deno.test('missing user_id: 2xx, no grant, event NOT marked (replayable)', async () => {
  const { d, calls } = fakeDeps();
  const r = await m.handle(await signed(txn({ custom_data: null })), d);
  assertEquals(r.status, 200);
  assertEquals(calls.grants.length, 0);
  assertEquals(calls.marked.length, 0);
});

Deno.test('quantity 2 grants two credits with distinct order ids', async () => {
  const { d, calls } = fakeDeps();
  await m.handle(await signed(txn({ items: [{ quantity: 2, price: { id: SMALL, unit_price: { amount: '3999', currency_code: 'USD' } } }] })), d);
  assertEquals(calls.grants.map(g => g[0]), ['txn_01abc', 'txn_01abc#2']);
});

Deno.test('grant failure -> 500 and event not marked (Paddle retries)', async () => {
  const { d, calls } = fakeDeps({ grantEvent: async () => { throw new Error('db down'); } });
  const r = await m.handle(await signed(txn()), d);
  assertEquals(r.status, 500);
  assertEquals(calls.marked.length, 0);
});

Deno.test('Pro initial transaction does not grant an event credit', async () => {
  const { d, calls } = fakeDeps();
  const r = await m.handle(await signed(txn({ subscription_id: 'sub_01xyz',
    items: [{ quantity: 1, price: { id: PRO, unit_price: { amount: '999', currency_code: 'USD' } } }] })), d);
  assertEquals(r.status, 200);
  assertEquals(calls.grants.length, 0);
});

Deno.test('subscription lifecycle maps to paypal_apply_sub statuses', async () => {
  const { d, calls } = fakeDeps();
  await m.handle(await signed(sub('active', {}, 'subscription.created')), d);
  await m.handle(await signed(sub('active', { scheduled_change: { action: 'cancel', effective_at: '2026-10-27T05:00:00Z' } })), d);
  await m.handle(await signed(sub('past_due')), d);
  await m.handle(await signed(sub('paused', {}, 'subscription.paused')), d);
  await m.handle(await signed(sub('canceled', {}, 'subscription.canceled')), d);
  assertEquals(calls.subs.map(s => s[2]), ['ACTIVE', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']);
  assertEquals(calls.subs[0], ['sub_01xyz', UID, 'ACTIVE', '2026-10-27T05:00:00Z']);
});

Deno.test('subscription without custom_data falls back to known owner', async () => {
  const { d, calls, owned } = fakeDeps();
  owned.set('sub_01xyz', UID);
  const r = await m.handle(await signed(sub('canceled', { custom_data: null }, 'subscription.canceled')), d);
  assertEquals(r.status, 200);
  assertEquals(calls.subs[0][1], UID);
});

Deno.test('subscription for a non-Pro price is ignored', async () => {
  const { d, calls } = fakeDeps();
  const r = await m.handle(await signed(sub('active', { items: [{ quantity: 1, price: { id: 'pri_other' } }] })), d);
  assertEquals(r.status, 200);
  assertEquals(calls.subs.length, 0);
});

Deno.test('live-signed event with sandbox price ids grants nothing', async () => {
  const { d, calls } = fakeDeps({ env: 'live' });
  await m.handle(await signed(txn()), d);
  assertEquals(calls.grants.length, 0);
});

Deno.test('sandbox: non-allowlisted buyer gets nothing (event not marked, 2xx)', async () => {
  const { d, calls } = fakeDeps({ userEmail: async () => 'stranger@example.com' });
  const r = await m.handle(await signed(txn()), d);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).skipped, 'sandbox_not_allowed');
  assertEquals(calls.grants.length, 0);
  assertEquals(calls.marked.length, 0);
  const r2 = await m.handle(await signed(sub('active', {}, 'subscription.created')), d);
  assertEquals(r2.status, 200);
  assertEquals(calls.subs.length, 0);
});

Deno.test('sandbox: empty allowlist grants to nobody; user without email gets nothing', async () => {
  let { d, calls } = fakeDeps({ sandboxAllow: [] });
  await m.handle(await signed(txn()), d);
  assertEquals(calls.grants.length, 0);
  ({ d, calls } = fakeDeps({ userEmail: async () => null }));
  await m.handle(await signed(txn()), d);
  assertEquals(calls.grants.length, 0);
});

Deno.test('sandbox: allowlist match is case-insensitive (QA@ vs qa@)', async () => {
  const { d, calls } = fakeDeps();
  await m.handle(await signed(txn()), d);
  assertEquals(calls.grants.length, 1);
});

Deno.test('live: allowlist is not consulted', async () => {
  const LIVE_PRICE = 'pri_live_medium';
  (m.PRICES.live as any)[LIVE_PRICE] = { kind: 'event', tier: 'medium', amount: '6999' };
  let asked = false;
  const { d, calls } = fakeDeps({ env: 'live', sandboxAllow: [], userEmail: async () => { asked = true; return 'x@y.z'; } });
  await m.handle(await signed(txn({ items: [{ quantity: 1, price: { id: LIVE_PRICE, unit_price: { amount: '6999', currency_code: 'USD' } } }] })), d);
  delete (m.PRICES.live as any)[LIVE_PRICE];
  assertEquals(calls.grants, [['txn_01abc', UID, 'medium']]);
  assertEquals(asked, false);
});

Deno.test('parseAllow trims, lowercases, drops empties', () => {
  assertEquals(m.parseAllow(' A@b.c, ,d@E.f ,'), ['a@b.c', 'd@e.f']);
  assertEquals(m.parseAllow(undefined), []);
});

Deno.test('unhandled event types are acknowledged', async () => {
  const { d } = fakeDeps();
  const r = await m.handle(await signed({ event_id: 'evt_c', event_type: 'customer.created', data: { id: 'ctm_1' } }), d);
  assertEquals(r.status, 200);
});

// ── запись тарифа: recordEventGrant ─────────────────────────────────────────
function fakeDb(opts: { tierFn?: 'ok' | 'missing' | 'fail'; fullUpdate?: 'ok' | 'fail' } = {}) {
  const calls: any[] = [];
  const db = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push(['rpc', fn, args]);
      if (fn === 'paypal_grant_event_tier') {
        if (opts.tierFn === 'missing') {
          return Promise.resolve({ error: { code: 'PGRST202', message: 'Could not find the function public.paypal_grant_event_tier' } });
        }
        if (opts.tierFn === 'fail') return Promise.resolve({ error: { code: '57014', message: 'timeout' } });
      }
      return Promise.resolve({ error: null });
    },
    from(table: string) {
      return {
        update(v: Record<string, unknown>) {
          return {
            eq(col: string, val: string) {
              calls.push(['update', table, v, col, val]);
              const fail = opts.fullUpdate === 'fail' && 'tier' in v;
              return Promise.resolve({ error: fail ? { message: 'column "tier" does not exist' } : null });
            },
          };
        },
      };
    },
  };
  return { db, calls };
}

Deno.test('recordEventGrant: with 054 the tier is written by one RPC, nothing else', async () => {
  for (const tier of ['small', 'medium', 'large'] as const) {
    const { db, calls } = fakeDb();
    assertEquals(await m.recordEventGrant(db, 'txn_1', UID, tier), 'tier');
    assertEquals(calls, [['rpc', 'paypal_grant_event_tier', { p_order_id: 'txn_1', p_user_id: UID, p_tier: tier }]]);
  }
});

Deno.test('recordEventGrant: before 054 falls back to paypal_grant_event + tier columns', async () => {
  const { db, calls } = fakeDb({ tierFn: 'missing' });
  assertEquals(await m.recordEventGrant(db, 'txn_2', UID, 'large'), 'legacy');
  assertEquals(calls[1], ['rpc', 'paypal_grant_event', { p_order_id: 'txn_2', p_user_id: UID }]);
  assertEquals(calls[2], ['update', 'paypal_orders',
    { kind: 'event_large', tier: 'large', guest_cap: 500, storage_gb: 400, amount: 129.99 }, 'order_id', 'txn_2']);
  assertEquals(calls.length, 3);
});

Deno.test('recordEventGrant: before 053 keeps at least kind=event_<tier>', async () => {
  const { db, calls } = fakeDb({ tierFn: 'missing', fullUpdate: 'fail' });
  const logs: unknown[] = [];
  assertEquals(await m.recordEventGrant(db, 'txn_3', UID, 'medium', (...a) => logs.push(a)), 'legacy');
  assertEquals(calls[3], ['update', 'paypal_orders', { kind: 'event_medium' }, 'order_id', 'txn_3']);
  assertEquals(logs.length, 0);
});

Deno.test('recordEventGrant: a real DB error is thrown (Paddle retries), no fallback grant', async () => {
  const { db, calls } = fakeDb({ tierFn: 'fail' });
  let threw = false;
  try { await m.recordEventGrant(db, 'txn_4', UID, 'small'); } catch { threw = true; }
  assert(threw);
  assertEquals(calls.length, 1);
});

Deno.test('isMissingFn recognises PostgREST and Postgres "no such function"', () => {
  assert(m.isMissingFn({ code: 'PGRST202', message: '' }));
  assert(m.isMissingFn({ code: '42883', message: 'function does not exist' }));
  assert(m.isMissingFn({ message: 'Could not find the function public.x in the schema cache' }));
  assert(!m.isMissingFn({ code: '23505', message: 'duplicate key' }));
  assert(!m.isMissingFn(null));
});

Deno.test('quantity > 1 grants each unit with the price tier under distinct order ids', async () => {
  const { d, calls } = fakeDeps();
  const body = txn({ items: [{ quantity: 2, price: { id: LARGE, unit_price: { amount: '12999', currency_code: 'USD' } } }] });
  const r = await m.handle(await signed(body), d);
  assertEquals(r.status, 200);
  assertEquals(calls.grants, [['txn_01abc', UID, 'large'], ['txn_01abc#2', UID, 'large']]);
});

// ── IP-фильтр ───────────────────────────────────────────────────────────────
const LIVE_IPS = ['34.237.3.244/32', '34.195.105.136/32', '34.232.58.13/32', '35.155.119.135/32', '34.212.5.7/32', '52.11.166.252/32'];

function withIp(req: Request, headers: Record<string, string>) {
  const h = new Headers(req.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Request(req, { headers: h });
}

Deno.test('ipInCidrs: exact /32, ranges, mapped IPv6, garbage', () => {
  assert(m.ipInCidrs('34.237.3.244', LIVE_IPS));
  assert(!m.ipInCidrs('34.237.3.245', LIVE_IPS));
  assert(m.ipInCidrs('10.1.2.3', ['10.0.0.0/8']));
  assert(!m.ipInCidrs('11.1.2.3', ['10.0.0.0/8']));
  assert(m.ipInCidrs('192.168.5.200', ['192.168.5.128/25']));
  assert(!m.ipInCidrs('192.168.5.10', ['192.168.5.128/25']));
  assert(m.ipInCidrs('::ffff:52.11.166.252', LIVE_IPS));
  assert(!m.ipInCidrs('2001:db8::1', LIVE_IPS));
  assert(!m.ipInCidrs('not-an-ip', LIVE_IPS));
  assert(!m.ipInCidrs('999.1.1.1', ['0.0.0.0/0']));
  assert(m.ipInCidrs('34.212.5.7', ['34.212.5.7']));        // голый адрес = /32
});

Deno.test('clientIp: first X-Forwarded-For hop, then CF-Connecting-IP, then X-Real-IP', () => {
  assertEquals(m.clientIp(new Headers({ 'x-forwarded-for': '34.237.3.244, 172.70.1.1, 10.0.0.1' })), { ip: '34.237.3.244', via: 'x-forwarded-for' });
  assertEquals(m.clientIp(new Headers({ 'cf-connecting-ip': '34.212.5.7' })), { ip: '34.212.5.7', via: 'cf-connecting-ip' });
  assertEquals(m.clientIp(new Headers({ 'x-real-ip': '1.2.3.4' })), { ip: '1.2.3.4', via: 'x-real-ip' });
  assertEquals(m.clientIp(new Headers({})), null);
});

Deno.test('IP allowlist: Paddle IP passes, foreign IP gets 403 before any processing', async () => {
  const { d, calls } = fakeDeps({ ipAllow: async () => LIVE_IPS });
  const ok = await m.handle(withIp(await signed(txn()), { 'x-forwarded-for': '34.232.58.13, 172.70.0.1' }), d as any);
  assertEquals(ok.status, 200);
  assertEquals(calls.grants.length, 1);

  const { d: d2, calls: c2 } = fakeDeps({ ipAllow: async () => LIVE_IPS });
  const bad = await m.handle(withIp(await signed(txn({ id: 'txn_02' })), { 'x-forwarded-for': '203.0.113.9' }), d2 as any);
  assertEquals(bad.status, 403);
  assertEquals(c2.grants.length, 0);
  assertEquals(c2.marked.length, 0);
});

Deno.test('IP allowlist never replaces the signature: Paddle IP + bad signature = 401', async () => {
  const { d, calls } = fakeDeps({ ipAllow: async () => LIVE_IPS });
  const r = await m.handle(withIp(await signed(txn(), { secret: 'wrong' }), { 'x-forwarded-for': '34.237.3.244' }), d as any);
  assertEquals(r.status, 401);
  assertEquals(calls.grants.length, 0);
});

Deno.test('IP list unavailable or no client IP header -> signature-only, logged', async () => {
  const { d, calls } = fakeDeps({ ipAllow: async () => null });
  const r = await m.handle(withIp(await signed(txn()), { 'x-forwarded-for': '203.0.113.9' }), d as any);
  assertEquals(r.status, 200);
  assertEquals(calls.grants.length, 1);
  assert(calls.logs.some(l => String(l[0]).includes('IP list unavailable')));

  const { d: d2, calls: c2 } = fakeDeps({ ipAllow: async () => { throw new Error('boom'); } });
  assertEquals((await m.handle(withIp(await signed(txn()), { 'x-forwarded-for': '203.0.113.9' }), d2 as any)).status, 200);
  assertEquals(c2.grants.length, 1);

  const { d: d3, calls: c3 } = fakeDeps({ ipAllow: async () => LIVE_IPS });
  assertEquals((await m.handle(await signed(txn()), d3 as any)).status, 200);   // без заголовков адреса
  assert(c3.logs.some(l => String(l[0]).includes('no client IP header')));
});

Deno.test('PADDLE_IP_CHECK=log lets a foreign IP through (logged), off skips the check', async () => {
  const { d, calls } = fakeDeps({ ipAllow: async () => LIVE_IPS, ipCheck: 'log' });
  assertEquals((await m.handle(withIp(await signed(txn()), { 'x-forwarded-for': '203.0.113.9' }), d as any)).status, 200);
  assert(calls.logs.some(l => String(l[0]).includes('non-Paddle IP')));
  let asked = false;
  const { d: d2 } = fakeDeps({ ipAllow: async () => { asked = true; return LIVE_IPS; }, ipCheck: 'off' });
  assertEquals((await m.handle(withIp(await signed(txn()), { 'x-forwarded-for': '203.0.113.9' }), d2 as any)).status, 200);
  assert(!asked);
});

Deno.test('makeIpList: parses data.ipv4_cidrs, caches 1h, retries failures after 1 min, keeps last good list', async () => {
  let t = 0, n = 0, fail = false;
  const f = (async (url: string) => {
    n++;
    assertEquals(url, 'https://api.paddle.com/ips');
    if (fail) return new Response('x', { status: 503 });
    return Response.json({ data: { ipv4_cidrs: LIVE_IPS } });
  }) as unknown as typeof fetch;
  const get = m.makeIpList(m.ipsUrl('live'), f, () => t);
  assertEquals(await get(), LIVE_IPS);
  t = 59 * 60 * 1000; await get(); assertEquals(n, 1);          // из кэша
  t = 61 * 60 * 1000; fail = true;
  assertEquals(await get(), LIVE_IPS); assertEquals(n, 2);      // сбой — прежний список
  t += 30 * 1000; await get(); assertEquals(n, 2);              // повтор не раньше минуты
  t += 31 * 1000; fail = false; await get(); assertEquals(n, 3);

  const bad = m.makeIpList(m.ipsUrl('live'), (async () => new Response('x', { status: 500 })) as unknown as typeof fetch, () => 0);
  assertEquals(await bad(), null);                              // никогда не было — null
  assertEquals(m.ipsUrl('sandbox'), 'https://sandbox-api.paddle.com/ips');
});

// ── Paddle ID покупателя для Retain ─────────────────────────────────────────
const CTM = 'ctm_01m3gnx0aaaaaaaaaaaaaaaaaa';

Deno.test('customer id: stored after an allowed event grant and a Pro subscription; never blocks', async () => {
  const saved: any[] = [];
  const { d } = fakeDeps({ setCustomer: async (...a: any[]) => { saved.push(a); } });
  assertEquals((await m.handle(await signed(txn({ customer_id: CTM })), d as any)).status, 200);
  assertEquals(saved, [[UID, 'sandbox', CTM]]);
  assertEquals((await m.handle(await signed(sub('active', { customer_id: CTM })), d as any)).status, 200);
  assertEquals(saved.length, 2);

  // не ctm_… — не пишем
  const { d: d2 } = fakeDeps({ setCustomer: async (...a: any[]) => { saved.push(a); } });
  await m.handle(await signed(txn({ id: 'txn_09', customer_id: 'ctm_01x' })), d2 as any);
  assertEquals(saved.length, 2);

  // песочница, чужая почта — ни выдачи, ни записи
  const { d: d3 } = fakeDeps({ setCustomer: async (...a: any[]) => { saved.push(a); }, userEmail: async () => 'stranger@example.com' });
  await m.handle(await signed(txn({ id: 'txn_10', customer_id: CTM })), d3 as any);
  assertEquals(saved.length, 2);

  // сбой записи не ломает выдачу
  const { d: d4, calls: c4 } = fakeDeps({ setCustomer: async () => { throw new Error('no fn'); } });
  const r = await m.handle(await signed(txn({ id: 'txn_11', customer_id: CTM })), d4 as any);
  assertEquals(r.status, 200);
  assertEquals(c4.grants.length, 1);
  assert(c4.logs.some(l => String(l[0]).includes('setCustomer failed')));
});

Deno.test('API base per env (live = api.paddle.com)', () => {
  assertEquals(m.API_BASE.live, 'https://api.paddle.com');
  assertEquals(m.API_BASE.sandbox, 'https://sandbox-api.paddle.com');
});

// ── Обе среды в одной функции ───────────────────────────────────────────────
const LIVE_SECRET = 'pdl_ntfset_live_test_secret';
const LSMALL = 'pri_01m3tf9j4sanm5rcxx38h4dvj7';
const LPRO = 'pri_01m3tf9jtgj1ne0rzqm3bgxbp3';
const SANDBOX_IPS = ['3.208.120.145/32', '54.234.237.108/32'];

Deno.test('dual env: live secret -> live prices, no email gate; sandbox secret -> sandbox prices + allowlist', async () => {
  let asked = false;
  const { d, calls } = fakeDeps({
    secrets: { live: LIVE_SECRET, sandbox: SECRET }, sandboxAllow: [],
    userEmail: async () => { asked = true; return 'stranger@example.com'; },
  });
  const liveTxn = txn({ id: 'txn_live1', items: [{ quantity: 1, price: { id: LSMALL, unit_price: { amount: '3999', currency_code: 'USD' } } }] });
  const r = await m.handle(await signed(liveTxn, { secret: LIVE_SECRET }), d as any);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).env, 'live');
  assertEquals(calls.grants, [['txn_live1', UID, 'small']]);
  assertEquals(asked, false);

  // та же песочная покупка, подписанная sandbox-секретом: allowlist пуст — ничего
  const r2 = await m.handle(await signed({ ...txn(), event_id: 'evt_sb2' }), d as any);
  assertEquals((await r2.json()).skipped, 'sandbox_not_allowed');
  assertEquals(calls.grants.length, 1);

  // live Pro-подписка
  const ls = sub('active', { items: [{ quantity: 1, price: { id: LPRO, unit_price: { amount: '999', currency_code: 'USD' } } }] }, 'subscription.activated');
  assertEquals((await m.handle(await signed(ls, { secret: LIVE_SECRET }), d as any)).status, 200);
  assertEquals(calls.subs.length, 1);
});

Deno.test('dual env: cross-env price ids never grant', async () => {
  const { d, calls } = fakeDeps({ secrets: { live: LIVE_SECRET, sandbox: SECRET } });
  // live-подпись + sandbox-цена
  await m.handle(await signed(txn(), { secret: LIVE_SECRET }), d as any);
  // sandbox-подпись + live-цена
  await m.handle(await signed({ ...txn({ items: [{ quantity: 1, price: { id: LSMALL, unit_price: { amount: '3999', currency_code: 'USD' } } }] }), event_id: 'evt_x2' }), d as any);
  assertEquals(calls.grants.length, 0);
});

Deno.test('dual env: missing live secret rejects live deliveries; unknown secret 401', async () => {
  const { d } = fakeDeps({ secrets: { sandbox: SECRET } });
  assertEquals((await m.handle(await signed(txn(), { secret: LIVE_SECRET }), d as any)).status, 401);
  const { d: d2 } = fakeDeps({ secrets: { live: '', sandbox: '' } });
  assertEquals((await m.handle(await signed(txn()), d2 as any)).status, 401);
});

Deno.test('dual env: IP list follows the env that signed; customer id stored per env', async () => {
  const askedFor: string[] = [];
  const saved: any[] = [];
  const { d, calls } = fakeDeps({
    secrets: { live: LIVE_SECRET, sandbox: SECRET },
    ipAllow: async (e: string) => { askedFor.push(e); return e === 'live' ? LIVE_IPS : SANDBOX_IPS; },
    setCustomer: async (...a: any[]) => { saved.push(a); },
  });
  const liveTxn = txn({ id: 'txn_l2', customer_id: CTM, items: [{ quantity: 1, price: { id: LSMALL, unit_price: { amount: '3999', currency_code: 'USD' } } }] });
  // live-событие с sandbox-адреса — 403
  const bad = await m.handle(withIp(await signed(liveTxn, { secret: LIVE_SECRET }), { 'x-forwarded-for': '3.208.120.145' }), d as any);
  assertEquals(bad.status, 403);
  // live-событие с live-адреса — ок
  const ok = await m.handle(withIp(await signed(liveTxn, { secret: LIVE_SECRET }), { 'x-forwarded-for': '52.11.166.252' }), d as any);
  assertEquals(ok.status, 200);
  // sandbox-событие с sandbox-адреса — ок
  const sb = await m.handle(withIp(await signed({ ...txn({ customer_id: CTM }), event_id: 'evt_sb9' }), { 'x-forwarded-for': '54.234.237.108' }), d as any);
  assertEquals(sb.status, 200);
  assertEquals(askedFor, ['live', 'live', 'sandbox']);
  assertEquals(calls.grants.length, 2);
  assertEquals(saved, [[UID, 'live', CTM], [UID, 'sandbox', CTM]]);
});
