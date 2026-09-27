// notify — отправка служебных писем из очереди email_log (миграция 055).
//
// Кто зовёт: сама база через pg_net (email_kick) сразу после постановки
// письма и раз в 5 минут по pg_cron; можно и вручную POST-ом. Тело не важно:
// функция лишь забирает созревшие строки (email_claim), рендерит их
// (../_shared/email.ts) и шлёт через Resend, отмечая итог (email_mark).
//
// verify_jwt=false и без секрета — сознательно: вызов может только ускорить
// отправку того, что база уже решила отправить. Лимиты, дедупликация и
// бюджет Resend живут в базе, не здесь.
//
// Секреты: RESEND_API_KEY (нет — строки ждут, в лог одна строка),
// EMAIL_DRY_RUN=1 — ничего не слать, только логировать (строки -> skipped).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { drain, sendResend, type EmailJob } from '../_shared/email.ts';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } });
const API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const DRY = Deno.env.get('EMAIL_DRY_RUN') === '1';

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  try {
    const out = await drain({
      apiKey: API_KEY,
      dryRun: DRY,
      async claim(limit) {
        const r = await sb.rpc('email_claim', { p_limit: limit });
        if (r.error) throw new Error('email_claim: ' + r.error.message);
        return (Array.isArray(r.data) ? r.data : []) as EmailJob[];
      },
      async mark(id, status, providerId, error) {
        const r = await sb.rpc('email_mark', { p_id: id, p_status: status, p_provider_id: providerId ?? null, p_error: error ?? null });
        if (r.error) console.error('email_mark', id, r.error.message);
      },
      send: (m) => sendResend(API_KEY, m),
      log: (...a) => console.log(...a),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    return json(200, { ok: true, ...out });
  } catch (e) {
    console.error('notify:', e instanceof Error ? e.message : e);
    return json(200, { ok: false });   // pg_net ответ не читает; ошибка уже в логе
  }
});
