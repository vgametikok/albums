// Тесты paypal-webhook без сети и базы: тариф по сумме/reference_id и запись
// кредита с тарифом (recordEventGrant) на подделанном клиенте.
//   deno test --allow-env --allow-net supabase/functions/paypal-webhook/
// (--allow-net нужен только чтобы Deno скачал импорт supabase-js из index.ts)
import { assert, assertEquals } from 'jsr:@std/assert@1';

Deno.env.set('PAYPAL_WEBHOOK_TEST', '1');
Deno.env.set('SUPABASE_URL', Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'test-service-key');
const m = await import('./index.ts');

const UID = '11111111-2222-4333-8444-555555555555';

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

Deno.test('tierByAmount: only exact USD tier prices', () => {
  assertEquals(m.tierByAmount('39.99', 'USD'), 'small');
  assertEquals(m.tierByAmount('69.99', 'USD'), 'medium');
  assertEquals(m.tierByAmount('129.99', 'USD'), 'large');
  assertEquals(m.tierByAmount('129.99', 'EUR'), null);
  assertEquals(m.tierByAmount('50.00', 'USD'), null);
});

Deno.test('tierOfUnit: reference_id must agree with the amount; legacy orders by amount', () => {
  assertEquals(m.tierOfUnit({ reference_id: 'event_large', amount: { value: '129.99', currency_code: 'USD' } }), 'large');
  assertEquals(m.tierOfUnit({ reference_id: 'event_large', amount: { value: '39.99', currency_code: 'USD' } }), null);
  assertEquals(m.tierOfUnit({ reference_id: 'event_huge', amount: { value: '39.99', currency_code: 'USD' } }), null);
  assertEquals(m.tierOfUnit({ amount: { value: '39.99', currency_code: 'USD' } }), 'small');
});

Deno.test('recordEventGrant: with 054 the tier is written by one RPC, nothing else', async () => {
  for (const tier of ['small', 'medium', 'large'] as const) {
    const { db, calls } = fakeDb();
    assertEquals(await m.recordEventGrant(db, 'ORDER1', UID, tier), 'tier');
    assertEquals(calls, [['rpc', 'paypal_grant_event_tier', { p_order_id: 'ORDER1', p_user_id: UID, p_tier: tier }]]);
  }
});

Deno.test('recordEventGrant: before 054 falls back to paypal_grant_event + tier columns', async () => {
  const { db, calls } = fakeDb({ tierFn: 'missing' });
  assertEquals(await m.recordEventGrant(db, 'ORDER2', UID, 'medium'), 'legacy');
  assertEquals(calls[1], ['rpc', 'paypal_grant_event', { p_order_id: 'ORDER2', p_user_id: UID }]);
  assertEquals(calls[2], ['update', 'paypal_orders',
    { kind: 'event_medium', tier: 'medium', guest_cap: 250, storage_gb: 200, amount: 69.99 }, 'order_id', 'ORDER2']);
  assertEquals(calls.length, 3);
});

Deno.test('recordEventGrant: before 053 keeps at least kind=event_<tier>', async () => {
  const { db, calls } = fakeDb({ tierFn: 'missing', fullUpdate: 'fail' });
  assertEquals(await m.recordEventGrant(db, 'ORDER3', UID, 'large', () => {}), 'legacy');
  assertEquals(calls[3], ['update', 'paypal_orders', { kind: 'event_large' }, 'order_id', 'ORDER3']);
});

Deno.test('recordEventGrant: a real DB error is thrown (PayPal retries), no fallback grant', async () => {
  const { db, calls } = fakeDb({ tierFn: 'fail' });
  let threw = false;
  try { await m.recordEventGrant(db, 'ORDER4', UID, 'small'); } catch { threw = true; }
  assert(threw);
  assertEquals(calls.length, 1);
});

Deno.test('isMissingFn recognises PostgREST and Postgres "no such function"', () => {
  assert(m.isMissingFn({ code: 'PGRST202', message: '' }));
  assert(m.isMissingFn({ code: '42883', message: 'function does not exist' }));
  assert(!m.isMissingFn({ code: '23505', message: 'duplicate key' }));
  assert(!m.isMissingFn(null));
});
