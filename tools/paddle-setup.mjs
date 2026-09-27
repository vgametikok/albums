#!/usr/bin/env node
/**
 * Paddle Billing: idempotent catalog + client token + webhook destination.
 *
 *   node tools/paddle-setup.mjs            # sandbox (default)
 *   PADDLE_ENV=live node tools/paddle-setup.mjs
 *
 * API key: env PADDLE_API_KEY, else ~/.config/paddle/<env>_key. Never printed.
 * Re-running is safe: products are matched by custom_data.albums_key, prices by
 * custom_data.albums_key, the client token by name, the destination by URL.
 * The destination secret is written to ~/.config/paddle/<env>_webhook_secret
 * (mode 600) when the destination is first created — it is never printed.
 * Output: the ids to paste into js/paddle-config.js and the edge function.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV = (process.env.PADDLE_ENV || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
const BASE = ENV === 'live' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
const DIR = join(homedir(), '.config', 'paddle');
const KEY = process.env.PADDLE_API_KEY || readFileSync(join(DIR, `${ENV}_key`), 'utf8').trim();
const WEBHOOK_URL = 'https://rizveurkjpcwrmbtoawj.supabase.co/functions/v1/paddle-webhook';
const SECRET_FILE = join(DIR, `${ENV}_webhook_secret`);

const CATALOG = [
  { key: 'event_small',  name: 'Event Album — Small',  desc: 'Shared event album: up to 100 guests, 100 GB. One-time payment.',
    kind: 'event', tier: 'small',  amount: '3999',  priceName: 'Event Album Small' },
  { key: 'event_medium', name: 'Event Album — Medium', desc: 'Shared event album: up to 250 guests, 200 GB. One-time payment.',
    kind: 'event', tier: 'medium', amount: '6999',  priceName: 'Event Album Medium' },
  { key: 'event_large',  name: 'Event Album — Large',  desc: 'Shared event album: up to 500 guests, 400 GB. One-time payment.',
    kind: 'event', tier: 'large',  amount: '12999', priceName: 'Event Album Large' },
  { key: 'pro_monthly',  name: 'Albums Pro',           desc: 'Albums Pro: photos up to 4K, videos up to 500 MB, 10 collaborators per album, analytics.',
    kind: 'pro', tier: null, amount: '999', priceName: 'Monthly', monthly: true },
];
const EVENTS = [
  'transaction.completed', 'transaction.paid',
  'subscription.created', 'subscription.activated', 'subscription.updated',
  'subscription.canceled', 'subscription.paused', 'subscription.resumed',
  'subscription.past_due', 'subscription.trialing',
];

async function api(path, method = 'GET', body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${JSON.stringify(j.error || j).slice(0, 400)}`);
  return j;
}
async function listAll(path) {
  const out = [];
  let url = path;
  for (;;) {
    const j = await api(url);
    out.push(...(j.data || []));
    const next = j.meta?.pagination?.has_more && j.meta.pagination.next;
    if (!next) break;
    url = next.replace(BASE, '');
  }
  return out;
}

const result = { env: ENV, prices: {}, products: {} };

const products = await listAll('/products?per_page=200&status=active,archived');
const prices = await listAll('/prices?per_page=200&status=active');
for (const c of CATALOG) {
  let p = products.find(x => x.custom_data?.albums_key === c.key && x.status === 'active');
  if (!p) {
    p = (await api('/products', 'POST', {
      name: c.name, description: c.desc, tax_category: 'saas', type: 'standard',
      custom_data: { albums_key: c.key, kind: c.kind, ...(c.tier ? { tier: c.tier } : {}) },
    })).data;
    console.error(`created product ${c.key} ${p.id}`);
  }
  let pr = prices.find(x => x.product_id === p.id && x.custom_data?.albums_key === c.key);
  if (pr && (pr.unit_price.amount !== c.amount || pr.unit_price.currency_code !== 'USD'
             || !!pr.billing_cycle !== !!c.monthly)) {
    throw new Error(`price ${pr.id} for ${c.key} exists with different terms — archive it by hand first`);
  }
  if (!pr) {
    pr = (await api('/prices', 'POST', {
      product_id: p.id,
      description: `${c.name} USD${c.monthly ? ' monthly' : ' one-time'}`,
      name: c.priceName,
      unit_price: { amount: c.amount, currency_code: 'USD' },
      ...(c.monthly ? { billing_cycle: { interval: 'month', frequency: 1 } } : {}),
      quantity: { minimum: 1, maximum: 1 },
      tax_mode: 'account_setting',
      custom_data: { albums_key: c.key, kind: c.kind, ...(c.tier ? { tier: c.tier } : {}) },
    })).data;
    console.error(`created price ${c.key} ${pr.id}`);
  }
  result.products[c.key] = p.id;
  result.prices[c.key] = pr.id;
}

// client-side token (public by design)
const TOKEN_NAME = 'albums.ink frontend';
const tokens = await listAll('/client-tokens?per_page=200&status=active');
let tok = tokens.find(x => x.name === TOKEN_NAME && x.status === 'active');
if (!tok) {
  tok = (await api('/client-tokens', 'POST', { name: TOKEN_NAME, description: 'Paddle.js on albums.ink' })).data;
  console.error('created client token ' + tok.id);
}
result.client_token = tok.token;

// webhook destination
const dests = await api('/notification-settings');
let d = (dests.data || []).find(x => x.destination === WEBHOOK_URL);
if (!d) {
  d = (await api('/notification-settings', 'POST', {
    description: `albums.ink paddle-webhook (${ENV})`,
    destination: WEBHOOK_URL, type: 'url', api_version: 1,
    include_sensitive_fields: false, traffic_source: 'all',
    subscribed_events: EVENTS,
  })).data;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(SECRET_FILE, d.endpoint_secret_key, { mode: 0o600 });
  chmodSync(SECRET_FILE, 0o600);
  console.error(`created notification setting ${d.id}; secret -> ${SECRET_FILE}`);
} else {
  const have = new Set((d.subscribed_events || []).map(e => e.name));
  if (EVENTS.some(e => !have.has(e))) {
    await api(`/notification-settings/${d.id}`, 'PATCH', { subscribed_events: EVENTS, active: true });
    console.error('updated subscribed events on ' + d.id);
  }
  if (!existsSync(SECRET_FILE)) console.error(`WARNING: ${SECRET_FILE} missing (secret only shown on create)`);
}
result.notification_setting = d.id;
console.log(JSON.stringify(result, null, 2));
