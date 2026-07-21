-- 019: поддержка переезда медиа на Cloudflare R2 (см. R2-PLAN.md).
--
-- Дисциплина миграций проекта соблюдена: здесь ТОЛЬКО новые объекты, ядро
-- видимости (can_view_media из 015) не переопределяется, а лишь вызывается.
-- Все функции — security definer, вызываются ТОЛЬКО из edge-функции r2-sign
-- под service-ключом (как mod_* из 018). Гранты anon/authenticated не выдаются;
-- вдобавок к опоре на `alter default privileges` из 015 — явный revoke в конце.
--
-- ПОРЯДОК: сначала таблицы, потом функции — Postgres проверяет тела SQL-функций
-- (language sql) при создании, и они ссылаются на таблицы ниже.
--
-- ДВА ИНВАРИАНТА, на которых стоит безопасность (продублированы в коде r2-sign):
--   1. viewer выводится ТОЛЬКО из проверенного JWT (getUser) в edge-слое и
--      НИКОГДА не берётся из тела запроса.
--   2. media-id ВСЕГДА заново извлекается из пути объекта; uid-сегмент пути в
--      авторизации не участвует. Никакая строка media, «заявленная» клиентом,
--      под проверку прав не подставляется.
-- Семантика квоты: считаются ТОЛЬКО R2-байты (оригинал + миниатюра по
-- зарезервированным размерам); легаси-медиа в Supabase Storage в квоту не входит.

-- ── Леджер резервирований (журнал занятого места) ───────────────────────────
-- Пишется ТОЛЬКО сервером атомарно при sign-upload. Квота считается по нему, а
-- НЕ по media.size_bytes (то поле пишет клиент без ограничений — доверять нельзя).
create table if not exists r2_reservations (
  media_id    uuid primary key,
  owner_id    uuid not null,
  size_bytes  bigint not null default 0,
  thumb_bytes bigint not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists r2_reservations_owner on r2_reservations(owner_id);
alter table r2_reservations enable row level security;   -- политик нет -> deny anon/authenticated
revoke all on r2_reservations from anon, authenticated;

-- ── Rate-limit: строка на попадание, счёт в скользящем окне (как mod_login_attempts) ──
create table if not exists r2_rate (
  key        text not null,
  created_at timestamptz not null default now()
);
create index if not exists r2_rate_key_ts on r2_rate(key, created_at);
alter table r2_rate enable row level security;
revoke all on r2_rate from anon, authenticated;

-- ── Батч-проверка права на просмотр ─────────────────────────────────────────
-- Возвращает подмножество media-id, которые viewer имеет право видеть. Ровно
-- тот же предикат can_view_media, что стоит в storage-политике media_read —
-- двойной рубеж сохранён. Массовая проверка одним вызовом вместо N.
create or replace function public.r2_can_view_media_batch(p_media uuid[], p_viewer uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  select m from unnest(p_media) as t(m) where can_view_media(m, p_viewer);
$$;

-- ── Использованный объём владельца по леджеру ───────────────────────────────
create or replace function public.r2_owner_usage(p_owner uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(size_bytes + thumb_bytes), 0)::bigint
    from r2_reservations where owner_id = p_owner;
$$;

-- ── Атомарное резервирование под квоту ──────────────────────────────────────
-- Под advisory-блокировкой владельца (защита от гонки параллельных заливок):
-- сперва ленивая уборка «осиротевших» резервирований этого владельца (PUT был
-- подписан, но строка media так и не появилась — ретрай/сбой), затем проверка
-- «сумма + новый файл ≤ квота» и вставка. Ленивая уборка держит квоту точной
-- без внешнего свипа: раздувание ограничено окном в 2 часа.
create or replace function public.r2_reserve_upload(
  p_owner uuid, p_media uuid, p_size bigint, p_thumb bigint, p_quota bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare used bigint;
begin
  perform pg_advisory_xact_lock(hashtext(p_owner::text));

  delete from r2_reservations r
   where r.owner_id = p_owner
     and r.created_at < now() - interval '2 hours'
     and not exists (select 1 from media m where m.id = r.media_id);

  select coalesce(sum(size_bytes + thumb_bytes), 0) into used
    from r2_reservations where owner_id = p_owner;

  if used + p_size + p_thumb > p_quota then
    return jsonb_build_object('ok', false, 'used', used, 'limit', p_quota);
  end if;

  insert into r2_reservations (media_id, owner_id, size_bytes, thumb_bytes)
  values (p_media, p_owner, greatest(p_size, 0), greatest(p_thumb, 0))
  on conflict (media_id) do update
    set size_bytes = excluded.size_bytes, thumb_bytes = excluded.thumb_bytes;

  return jsonb_build_object('ok', true, 'used', used + p_size + p_thumb, 'limit', p_quota);
end $$;

-- ── Rate-limit: перед счётом чистит своё же старьё, поэтому таблица не растёт ──
create or replace function public.r2_rate_hit(p_key text, p_limit int, p_window_sec int)
returns boolean language plpgsql security definer set search_path = public as $$
declare cnt int;
begin
  delete from r2_rate where key = p_key and created_at < now() - make_interval(secs => p_window_sec);
  insert into r2_rate (key) values (p_key);
  select count(*) into cnt from r2_rate
   where key = p_key and created_at > now() - make_interval(secs => p_window_sec);
  return cnt <= p_limit;
end $$;

-- ── Информационный чек на media.size_bytes ──────────────────────────────────
-- Поле остаётся справочным (в квоте не участвует), но пусть не будет отрицательным.
-- CHECK допускает NULL, существующим строкам (size = body.size ≥ 0) не мешает.
alter table media drop constraint if exists media_size_nonneg;
alter table media add constraint media_size_nonneg check (size_bytes >= 0);

-- ── Гранты: явный revoke на каждую новую функцию ────────────────────────────
-- Страховка поверх `alter default privileges ... revoke` из 015. service_role
-- сохраняет доступ (его execute не через PUBLIC — проверено тем, что mod_* из
-- 018 работают под service-ключом без грантов).
revoke execute on function
  public.r2_can_view_media_batch(uuid[], uuid),
  public.r2_owner_usage(uuid),
  public.r2_reserve_upload(uuid, uuid, bigint, bigint, bigint),
  public.r2_rate_hit(text, int, int)
from public, anon, authenticated;
