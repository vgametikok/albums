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
  const d = {
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

Deno.test('live env with empty price table grants nothing for sandbox ids', async () => {
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
