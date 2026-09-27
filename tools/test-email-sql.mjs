// Тесты очереди писем (миграция 055) на PGlite: заглушки auth/pg_net, поверх 053+054.
// Запуск: npm i --no-save @electric-sql/pglite && node tools/test-email-sql.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
const db = new PGlite();
const M = new URL('../supabase/migrations/', import.meta.url).pathname;
const pre = `
create schema if not exists auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create table auth.users (id uuid primary key, email text, is_anonymous boolean default false, last_sign_in_at timestamptz,
  raw_user_meta_data jsonb default '{}');
create table auth.sessions (id uuid primary key, user_id uuid, created_at timestamptz default now());
create schema net;
create table net.calls (id serial, url text, body jsonb);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
  returns bigint language sql as $$ insert into net.calls (url, body) values (url, body) returning id::bigint $$;
create role authenticated; create role anon;
create type visibility_level as enum ('public','friends','private');
create table profiles (id uuid primary key, username text unique, display_name text, avatar_url text, plan text default 'free', plan_since timestamptz, plan_until timestamptz,
  country text, created_at timestamptz default now(), banned_at timestamptz, deleted_at timestamptz);
create table albums (id uuid primary key default gen_random_uuid(), author_id uuid references profiles(id), title text, description text,
  visibility visibility_level, is_event boolean not null default false, event_hold_guest boolean not null default false,
  published_at timestamptz, moderation_status text default 'pending', created_at timestamptz not null default now(), updated_at timestamptz default now(),
  photos_count int default 0, videos_count int default 0, cover_media_id uuid);
create table media (id uuid primary key default gen_random_uuid(), owner_id uuid, kind text default 'photo', storage_path text, thumb_path text, size_bytes bigint, created_at timestamptz default now());
create table album_media (id uuid primary key default gen_random_uuid(), album_id uuid, media_id uuid, visibility visibility_level, position int);
create table album_collaborators (album_id uuid, user_id uuid);
create table posts(id int); create table comments(id int); create table likes(id int);
create table reports(id int, status text);
create table stat_events(created_at timestamptz, kind text, dwell_ms int, day date, actor_id uuid, country text, album_id uuid);
create table event_quota (user_id uuid primary key references profiles(id), credits int not null default 0 check (credits>=0), granted_total int not null default 0, updated_at timestamptz default now());
create table paypal_orders (order_id text primary key, user_id uuid not null references profiles(id), kind text not null default 'event', status text not null, created_at timestamptz not null default now());
create table paypal_subscriptions (subscription_id text primary key, user_id uuid references profiles(id), status text not null, current_period_end timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table r2_reservations (media_id uuid primary key, owner_id uuid, size_bytes bigint default 0, thumb_bytes bigint default 0, created_at timestamptz default now());
create table mod_media_queue (am_id uuid primary key, album_id uuid, media_id uuid, added_at timestamptz default now(), reviewed_at timestamptz, reviewed_by text, decision text);
create function trg_touch_updated() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create trigger albums_touch_t before update on albums for each row execute function trg_touch_updated();
`;
const f026 = fs.readFileSync(M + '026_event_albums_paid.sql', 'utf8');
const g = f026.slice(f026.indexOf('create or replace function public.trg_album_event_guard()'), f026.indexOf('-- ---------------------------------------------------------------- постоянная ссылка'));
const f040 = fs.readFileSync(M + '040_paypal_orders.sql', 'utf8');
const pge = f040.slice(f040.indexOf('create or replace function public.paypal_grant_event'));
const f031 = fs.readFileSync(M + '031_paypal.sql', 'utf8');
const applySub = f031.slice(f031.indexOf('create or replace function public.paypal_apply_sub('), f031.indexOf('-- Плановый спуск'));
const U = (n) => `aaaaaaaa-0000-0000-0000-00000000000${n}`;
const S = (n) => `dddddddd-0000-0000-0000-00000000000${n}`;
const q = async (s) => (await db.query(s)).rows;
const one = async (s) => Object.values((await q(s))[0] ?? { x: null })[0];
let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const log = (where = 'true') => q(`select kind, status, item_count as n from email_log where ${where} order by id`);
const kicks = () => one(`select count(*)::int from net.calls`);

await db.exec(pre + g + pge + applySub + `
insert into profiles (id, username, display_name) values ('${U(1)}','old','Old User');
insert into auth.users (id, email, last_sign_in_at) values ('${U(1)}','old@x', now() - interval '2 days');
`);
await db.exec(fs.readFileSync(M + '053_event_tiers.sql', 'utf8'));
await db.exec(fs.readFileSync(M + '054_event_credit_tiers.sql', 'utf8'));
const m55 = fs.readFileSync(M + '055_email_log.sql', 'utf8');
await db.exec(m55);
await db.exec(m55);   // re-run safe

eq('existing users backfilled as welcomed', await q(`select welcomed from email_user_state`), [{ welcomed: true }]);

// ── existing user: page load right after migration = no mail
const asUser = async (uid, sid, locale = 'ru', ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0') => {
  await db.exec(`set test.uid = '${uid}'; set request.jwt.claims = '{"sub":"${uid}","session_id":"${sid}","role":"authenticated"}';
                 set request.headers = '{"user-agent":"${ua}"}'`);
  const r = await one(`select ensure_profile('${locale}')`);
  await db.exec(`reset test.uid; reset request.jwt.claims; reset request.headers`);
  return r;
};
await db.exec(`insert into auth.sessions (id, user_id, created_at) values ('${S(1)}','${U(1)}', now() - interval '2 days')`);
await asUser(U(1), S(1));
eq('old session after migration -> nothing', await log(), []);
// new sign-in (new session)
await db.exec(`insert into auth.sessions (id, user_id, created_at) values ('${S(2)}','${U(1)}', now())`);
await asUser(U(1), S(2));
eq('new session -> signin mail', await log(), [{ kind: 'signin', status: 'pending', n: 1 }]);
eq('signin payload ua', (await one(`select payload from email_log where kind='signin'`)).ua.includes('Chrome'), true);
eq('locale stored', await one(`select locale from email_user_state where user_id='${U(1)}'`), 'ru');
eq('immediate mail kicks notify', await kicks(), 1);
await asUser(U(1), S(2));
eq('same session reload -> no new mail', (await log()).length, 1);
await db.exec(`insert into auth.sessions (id, user_id, created_at) values ('${S(3)}','${U(1)}', now() + interval '1 second')`);
await asUser(U(1), S(3));
eq('second sign-in within 24h -> suppressed', (await log()).length, 1);
await asUser(U(1), S(3), 'de');
eq('locale follows site language', await one(`select locale from email_user_state where user_id='${U(1)}'`), 'de');
await asUser(U(1), S(3), 'xx');
eq('bad locale ignored', await one(`select locale from email_user_state where user_id='${U(1)}'`), 'de');

// ── brand-new Google user: welcome once, no signin on first sign-in
await db.exec(`insert into auth.users (id, email, last_sign_in_at, raw_user_meta_data) values ('${U(2)}','new@x', now(), '{"full_name":"Anna"}');
               insert into auth.sessions (id, user_id, created_at) values ('${S(4)}','${U(2)}', now())`);
const r2 = await asUser(U(2), S(4), 'ru');
eq('profile created', r2.created, true);
eq('welcome queued, no signin', await log(`user_id='${U(2)}'`), [{ kind: 'welcome', status: 'pending', n: 1 }]);
await asUser(U(2), S(4), 'ru');
eq('reload -> still only welcome', (await log(`user_id='${U(2)}'`)).length, 1);
// old 0-arg call still works
await db.exec(`set test.uid = '${U(2)}'`);
eq('ensure_profile() without args', (await one(`select ensure_profile()`)).created, false);
await db.exec(`reset test.uid`);

// ── anonymous guest: profile yes, mail never
await db.exec(`insert into auth.users (id, email, is_anonymous, last_sign_in_at) values ('${U(3)}', null, true, now())`);
await asUser(U(3), S(5));
eq('guest gets no mail', await log(`user_id='${U(3)}'`), []);

// ── moderation digests
await db.exec(`update email_log set status='sent', sent_at=now()`);   // clear
const A = 'bbbbbbbb-0000-0000-0000-000000000001';
await db.exec(`insert into albums (id, author_id, title, visibility, is_event) values ('${A}', '${U(1)}', 'Свадьба', 'private', true)`);
const addMedia = async (i, owner, bytes = 1000) => {
  const mid = `cccccccc-0000-0000-0000-${String(i).padStart(12, '0')}`;
  const am = `eeeeeeee-0000-0000-0000-${String(i).padStart(12, '0')}`;
  await db.exec(`insert into media (id, owner_id) values ('${mid}', '${owner}');
    insert into r2_reservations (media_id, owner_id, size_bytes) values ('${mid}', '${owner}', ${bytes});
    insert into album_media (id, album_id, media_id) values ('${am}', '${A}', '${mid}');
    insert into mod_media_queue (am_id, album_id, media_id) values ('${am}', '${A}', '${mid}')`);
  return am;
};
const am1 = await addMedia(1, U(2)); await addMedia(2, U(2)); await addMedia(3, U(2));
eq('3 uploads -> one pending digest x3', await log(`kind='mod_pending'`), [{ kind: 'mod_pending', status: 'pending', n: 3 }]);
eq('digest waits 10 min', await one(`select send_after > now() + interval '9 minutes' from email_log where kind='mod_pending'`), true);
await addMedia(4, U(3));
eq('guest uploader -> no mail', (await log(`kind='mod_pending'`)).length, 1);
// sent, then more uploads within the hour -> next digest not before sent_at + 1h
await db.exec(`update email_log set status='sent', sent_at=now() where kind='mod_pending'`);
await addMedia(5, U(2)); await addMedia(6, U(2));
eq('after send: new digest x2', await log(`kind='mod_pending'`), [{ kind: 'mod_pending', status: 'sent', n: 3 }, { kind: 'mod_pending', status: 'pending', n: 2 }]);
eq('next digest >= 1h after previous', await one(`select send_after >= now() + interval '59 minutes' from email_log where kind='mod_pending' and status='pending'`), true);
// approvals
await db.exec(`update mod_media_queue set reviewed_at=now(), reviewed_by='mod', decision='approved' where am_id='${am1}'`);
await db.exec(`update mod_media_queue set reviewed_at=now(), reviewed_by='mod', decision='approved' where media_id in (select id from media where owner_id='${U(2)}') and decision is null`);
eq('approved digest', await log(`kind='mod_approved'`), [{ kind: 'mod_approved', status: 'pending', n: 5 }]);
eq('unsent pending digest superseded', await one(`select status from email_log where kind='mod_pending' order by id desc limit 1`), 'skipped');
await db.exec(`update mod_media_queue set decision='hidden' where am_id='${am1}'`);
eq('hide does not mail', (await log(`kind='mod_approved'`))[0].n, 5);
eq('backfill approvals do not mail', await (async () => { await db.exec(`update mod_media_queue set reviewed_by='backfill', decision='approved' where decision is null`); return (await log(`kind='mod_approved'`)).length; })(), 1);

// ── purchases
eq('paddle grant -> purchase mail', await one(`select paypal_grant_event_tier('txn_A','${U(2)}','medium')`), true);
await db.exec(`select paypal_grant_event_tier('txn_A','${U(2)}','medium')`);
await db.exec(`select paypal_grant_event_tier('txn_A#2','${U(2)}','medium')`);
eq('one mail per transaction, count 2', await log(`kind='purchase_event'`), [{ kind: 'purchase_event', status: 'pending', n: 2 }]);
await db.exec(`select paypal_grant_event_tier('5KX123','${U(2)}','large')`);
eq('paypal order -> own mail', (await log(`kind='purchase_event'`)).length, 2);
await db.exec(`select admin_grant_event('new', 1, 'large')`);
eq('admin grant -> no mail', (await log(`kind='purchase_event'`)).length, 2);
await db.exec(`select paypal_apply_sub('sub_1','${U(2)}','ACTIVE', now() + interval '30 days')`);
await db.exec(`select paypal_apply_sub('sub_1','${U(2)}','ACTIVE', now() + interval '60 days')`);
await db.exec(`select paypal_apply_sub('sub_1','${U(2)}','PAST_DUE', null)`);
await db.exec(`select paypal_apply_sub('sub_1','${U(2)}','ACTIVE', now() + interval '90 days')`);
eq('pro: one mail per subscription', await log(`kind='purchase_pro'`), [{ kind: 'purchase_pro', status: 'pending', n: 1 }]);
await db.exec(`insert into paypal_subscriptions (subscription_id, user_id, status) values ('I-PP1','${U(1)}','APPROVAL_PENDING')`);
await db.exec(`select paypal_apply_sub('I-PP1','${U(1)}','ACTIVE', now() + interval '30 days')`);
eq('paypal pending -> active mails', (await log(`kind='purchase_pro'`)).length, 2);

// ── storage 80%
await db.exec(`update albums set event_storage_gb = 1 where id='${A}'`);   // guard lets superuser session through
await addMedia(20, U(2), 700 * 1048576);
eq('70% -> no mail', await log(`kind='storage80'`), []);
await addMedia(21, U(2), 150 * 1048576);
eq('>80% -> storage mail', await log(`kind='storage80'`), [{ kind: 'storage80', status: 'pending', n: 1 }]);
await addMedia(22, U(2), 10 * 1048576);
eq('once per period', (await log(`kind='storage80'`)).length, 1);
eq('storage80 goes to album owner', await one(`select user_id from email_log where kind='storage80'`), U(1));

// ── claim / budget / mark
await db.exec(`update email_log set send_after = now() - interval '1 second' where status='pending'`);
let first = await one(`select email_claim(4)`);
eq('claim priority: purchases first', first.map(x => x.kind).sort(), ['purchase_event', 'purchase_event', 'purchase_pro', 'purchase_pro']);
let batch = first.concat(await one(`select email_claim(50)`));
const pe = batch.find(x => x.kind === 'purchase_event');
eq('claim resolves order tier + recipient', [pe.order.tier, pe.order.storage_gb, pe.to, pe.locale, pe.count], ['medium', 200, 'new@x', 'ru', 2]);
const s80 = batch.find(x => x.kind === 'storage80');
eq('claim resolves album', [s80.album.title, s80.album.storage_gb, s80.to, s80.locale], ['Свадьба', 1, 'old@x', 'de']);
eq('claimed rows are sending', await one(`select count(*)::int from email_log where status='sending'`), batch.length);
eq('second claim gets nothing', (await one(`select email_claim(50)`)).length, 0);
await db.exec(`select email_mark(${pe.id}, 'sent', 're_1'); select email_mark(${s80.id}, 'retry', null, '429')`);
eq('mark sent/retry', await q(`select status, provider_id from email_log where id in (${pe.id}, ${s80.id}) order by id`), [{ status: 'sent', provider_id: 're_1' }, { status: 'pending', provider_id: null }]);
// daily cap keeps the tail for purchases/welcome
await db.exec(`update email_config set daily_cap = ${await one(`select count(*)::int from email_log where status in ('sent','sending') and coalesce(sent_at, claimed_at) > now() - interval '24 hours'`)} + 5`);
await db.exec(`insert into email_log (kind, user_id, dedupe_key) values ('signin','${U(1)}','t-signin'), ('welcome','${U(1)}','t-welcome')`);
batch = await one(`select email_claim(50)`);
eq('near cap: only welcome/purchase', batch.map(x => x.kind), ['welcome']);
await db.exec(`update email_config set daily_cap = 0`);
eq('cap reached -> nothing', (await one(`select email_claim(50)`)).length, 0);
await db.exec(`update email_config set daily_cap = 90`);
// stale signin expires
await db.exec(`update email_log set created_at = now() - interval '7 hours' where dedupe_key='t-signin'`);
await db.exec(`select email_claim(1)`);
eq('stale signin expired', await one(`select status from email_log where dedupe_key='t-signin'`), 'expired');
// grants
eq('client cannot call email_claim', await one(`select has_function_privilege('authenticated', 'public.email_claim(int)', 'execute')`), false);
eq('client can call ensure_profile(text)', await one(`select has_function_privilege('authenticated', 'public.ensure_profile(text)', 'execute')`), true);
eq('failures never break flow (no table access for email) ', true, true);
console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
