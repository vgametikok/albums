// deno test --allow-env   (из supabase/functions/_shared)
import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  buildDoc, drain, esc, LOCALES, parseUA, pickLocale, render, sendResend, STR, tr, type EmailJob, type Kind,
} from './email.ts';

const KINDS: Kind[] = ['welcome', 'signin', 'mod_pending', 'mod_approved', 'purchase_event', 'purchase_pro', 'storage80'];
const job = (kind: Kind, over: Partial<EmailJob> = {}): EmailJob => ({
  id: 7, kind, count: 3, to: 'a@b.c', locale: 'ru', name: 'Анна',
  created_at: '2026-09-27T10:00:00Z',
  payload: { at: '2026-09-27T10:00:00Z', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1', used_bytes: 170 * 1073741824, cap_gb: 200 },
  album: { id: '11111111-2222-3333-4444-555555555555', title: 'Свадьба <Ани & Пети>', is_event: true, storage_gb: 200 },
  order: { tier: 'medium', storage_gb: 200, amount: 69.99 },
  ...over,
});

Deno.test('every locale has every key', () => {
  const keys = Object.keys(STR.en);
  for (const l of LOCALES) {
    const missing = keys.filter((k) => !(k in STR[l]));
    assertEquals(missing, [], `missing in ${l}`);
  }
});

Deno.test('all kinds render in all locales, no unfilled placeholders', () => {
  for (const l of LOCALES) for (const k of KINDS) {
    for (const count of [1, 2, 5, 21]) {
      const r = render(job(k, { locale: l, count }))!;
      assert(r, `${k}/${l}`);
      for (const part of [r.subject, r.text, r.html]) {
        assert(!/\{\w+\}/.test(part), `placeholder left in ${k}/${l}: ${part.slice(0, 200)}`);
      }
      assert(r.subject.length > 5 && r.subject.length <= 180);
      assertStringIncludes(r.html, 'support@albums.ink');
      assertStringIncludes(r.text, 'support@albums.ink');
      assertStringIncludes(r.html, `lang="${l}"`);
    }
  }
});

Deno.test('user text is escaped in HTML, kept readable in text', () => {
  const r = render(job('mod_pending'))!;
  assert(!r.html.includes('<Ани'), 'raw tag leaked');
  assertStringIncludes(r.html, '&lt;Ани &amp; Пети&gt;');
  assertStringIncludes(r.text, 'Свадьба <Ани & Пети>');
  assertEquals(esc(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
});

Deno.test('russian plurals', () => {
  assertEquals(tr('ru', 'files', { n: 1 }), '1 файл');
  assertEquals(tr('ru', 'files', { n: 3 }), '3 файла');
  assertEquals(tr('ru', 'files', { n: 5 }), '5 файлов');
  assertEquals(tr('ru', 'files', { n: 21 }), '21 файл');
  assertEquals(tr('en', 'files', { n: 1 }), '1 file');
  assertEquals(tr('en', 'files', { n: 2 }), '2 files');
});

Deno.test('locale fallback', () => {
  assertEquals(pickLocale(null), 'en');
  assertEquals(pickLocale('zh'), 'zh-CN');
  assertEquals(pickLocale('de-AT'), 'de');
  assertEquals(pickLocale('pt'), 'en');
  const r = render(job('welcome', { locale: 'xx' }))!;
  assertEquals(r.locale, 'en');
});

Deno.test('purchase_event: tier, storage, 6 months, taxes, cabinet link', () => {
  const d = buildDoc(job('purchase_event', { count: 1 }))!;
  const text = JSON.stringify(d);
  assertStringIncludes(d.subject, 'Средний');
  assertStringIncludes(text, '200 ГБ');
  assertStringIncludes(text, '6 месяцев');
  assertStringIncludes(text, 'налоги включены');
  assertStringIncludes(text, '$69.99');
  assertStringIncludes(text, 'Общий альбом');
  assertEquals(d.cta.url, 'https://albums.ink/event.html');
  const en = buildDoc(job('purchase_event', { locale: 'en', order: { tier: 'large' }, count: 2 }))!;
  assertStringIncludes(JSON.stringify(en), '400 GB');
  assertStringIncludes(JSON.stringify(en), '2 × Event Album — Large');
  assertStringIncludes(JSON.stringify(en), '$129.99 · taxes included');
});

Deno.test('purchase_pro: price with taxes, profile link', () => {
  const d = buildDoc(job('purchase_pro', { locale: 'en' }))!;
  assertStringIncludes(JSON.stringify(d), '$9.99 / month · taxes included');
  assertEquals(d.cta.url, 'https://albums.ink/profile.html');
});

Deno.test('storage80: usage, packs, mailto CTA', () => {
  const d = buildDoc(job('storage80', { locale: 'en' }))!;
  const s = JSON.stringify(d);
  assertStringIncludes(s, '170 GB of 200 GB (85%)');
  for (const p of ['+30 GB', '$15.99', '+70 GB', '$34.99', '+100 GB', '$48.99']) assertStringIncludes(s, p);
  assert(d.cta.url.startsWith('mailto:support@albums.ink?subject='));
  assertStringIncludes(decodeURIComponent(d.cta.url), '11111111-2222-3333-4444-555555555555');
  assertEquals(d.link?.url, 'https://albums.ink/event.html?id=11111111-2222-3333-4444-555555555555');
});

Deno.test('signin: device and UTC time', () => {
  const d = buildDoc(job('signin', { locale: 'en' }))!;
  const s = JSON.stringify(d);
  assertStringIncludes(s, 'Safari, iOS');
  assertStringIncludes(s, 'UTC');
  assertStringIncludes(s, 'September 27, 2026');
  assertEquals(parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'), 'Chrome, Windows');
  assertEquals(parseUA('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/129.0 Safari/537.36 Edg/129.0'), 'Edge, Windows');
  assertEquals(parseUA('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36'), 'Chrome, Android');
  assertEquals(parseUA(''), '');
  const unk = buildDoc(job('signin', { locale: 'en', payload: {} }))!;
  assertStringIncludes(JSON.stringify(unk), 'Unknown device');
});

Deno.test('greeting falls back without a name', () => {
  assertEquals(buildDoc(job('welcome', { name: null, username: null, locale: 'en' }))!.greeting, 'Hi,');
  assertEquals(buildDoc(job('welcome', { name: null, username: 'kate', locale: 'en' }))!.greeting, 'Hi kate,');
});

// ── drain ─────────────────────────────────────────────────────────────────
function fakeDeps(jobs: EmailJob[], send: (m: any) => any, over: Record<string, unknown> = {}) {
  const marks: [number, string, string | null | undefined][] = [];
  const sent: any[] = [];
  const logs: unknown[][] = [];
  return {
    marks, sent, logs,
    deps: {
      apiKey: 're_test',
      claim: async () => jobs,
      mark: async (id: number, st: string, pid?: string | null) => { marks.push([id, st, pid]); },
      send: async (m: any) => { sent.push(m); return send(m); },
      log: (...a: unknown[]) => logs.push(a),
      ...over,
    } as any,
  };
}

Deno.test('drain without API key: logs, claims nothing', async () => {
  let claimed = false;
  const f = fakeDeps([job('welcome')], () => ({ ok: true }), { apiKey: '', claim: async () => { claimed = true; return []; } });
  const r = await drain(f.deps);
  assertEquals(r, { skipped: 'no_api_key' });
  assertEquals(claimed, false);
  assertStringIncludes(String(f.logs[0][0]), 'RESEND_API_KEY');
});

Deno.test('drain: sent / retry / failed / skipped', async () => {
  const jobs = [job('welcome', { id: 1 }), job('signin', { id: 2 }), job('mod_approved', { id: 3 }), job('welcome', { id: 4, to: null }), job('welcome', { id: 5, anon: true })];
  const f = fakeDeps(jobs, (m) => m.ref.endsWith('-1') ? { ok: true, id: 're_1' } : m.ref.endsWith('-2') ? { ok: false, retry: true, error: '429' } : { ok: false, error: '422' });
  const r = await drain(f.deps);
  assertEquals(r, { claimed: 5, sent: 1, skipped: 2, retry: 1, failed: 1 });
  assertEquals(f.marks.map((m) => m[1]), ['sent', 'retry', 'failed', 'skipped', 'skipped']);
  assertEquals(f.sent[0].ref, 'albums-email-1');
  assertEquals(f.sent.length, 3);
});

Deno.test('drain: a throwing send never stops the batch', async () => {
  const f = fakeDeps([job('welcome', { id: 1 }), job('welcome', { id: 2 })], (m) => { if (m.ref.endsWith('-1')) throw new Error('boom'); return { ok: true, id: 'x' }; });
  const r = await drain(f.deps) as { sent: number };
  assertEquals(r.sent, 1);
  assertEquals(f.marks.map((m) => m[1]), ['retry', 'sent']);
});

Deno.test('drain dry run sends nothing', async () => {
  const f = fakeDeps([job('welcome')], () => { throw new Error('must not send'); }, { apiKey: '', dryRun: true });
  const r = await drain(f.deps) as { skipped: number };
  assertEquals(r.skipped, 1);
  assertEquals(f.sent.length, 0);
});

Deno.test('sendResend: request shape and error mapping', async () => {
  let seen: any = null;
  const ok = await sendResend('re_k', { to: 'x@y.z', subject: 'S', html: '<p>h</p>', text: 't', kind: 'welcome', ref: 'albums-email-9' },
    async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); });
  assertEquals(ok, { ok: true, id: 'em_1' });
  assertEquals(seen.url, 'https://api.resend.com/emails');
  assertEquals(seen.init.headers['Idempotency-Key'], 'albums-email-9');
  assertEquals(seen.init.headers.Authorization, 'Bearer re_k');
  const body = JSON.parse(seen.init.body);
  assertEquals([body.from, body.reply_to, body.to], ['Albums.ink <noreply@albums.ink>', 'support@albums.ink', ['x@y.z']]);
  const r429 = await sendResend('k', { to: 'x', subject: '', html: '', text: '', kind: 'welcome', ref: 'r' }, async () => new Response('{"message":"rate"}', { status: 429 }));
  assertEquals(r429.retry, true);
  const r422 = await sendResend('k', { to: 'x', subject: '', html: '', text: '', kind: 'welcome', ref: 'r' }, async () => new Response('{"message":"bad"}', { status: 422 }));
  assertEquals([r422.ok, r422.retry], [false, false]);
  const net = await sendResend('k', { to: 'x', subject: '', html: '', text: '', kind: 'welcome', ref: 'r' }, async () => { throw new Error('dns'); });
  assertEquals(net.retry, true);
});
