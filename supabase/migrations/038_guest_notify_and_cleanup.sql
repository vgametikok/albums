-- =====================================================================
-- 038: телеграм-шум от гостей — под контроль; брошенные анонимы — под метлу.
--
--  1. «Новая регистрация» больше не приходит на анонимных гостей (037):
--     технический профиль user123 — не регистрация. Вместо этого владельцу
--     приходит «Новое медиа в альбоме …», когда КТО-ТО КРОМЕ АВТОРА кладёт
--     файл в его альбом. Чтобы пачка из 30 фото не превратилась в 30
--     сообщений, уведомления по одному альбому не чаще раза в 30 минут;
--     накопившееся между пингами досылается счётчиком «и ещё N».
--
--  2. Анонимные аккаунты без контента (нет ни файлов, ни комментариев,
--     ни постов) старше 30 дней удаляются раз в сутки по pg_cron.
--     От удалённых остаётся только количество — журнал anon_cleanup_log.
-- =====================================================================

-- ---------------------------------------------------------------- регистрация: без анонимов

create or replace function public.trg_notify_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Анонимный гость — не регистрация: про него владелец узнает из
  -- «Новое медиа в альбоме», а профиль-заглушку рекламировать незачем.
  if exists (select 1 from auth.users u where u.id = new.id and coalesce(u.is_anonymous, false)) then
    return new;
  end if;
  perform notify_telegram(
    '🆕 Новая регистрация' || chr(10) ||
    '@' || new.username || coalesce(' — ' || new.display_name, ''));
  return new;
exception when others then
  return new;   -- сборка текста не должна ронять саму регистрацию
end $$;

-- ---------------------------------------------------------------- новое медиа в альбоме

-- Троттлинг пингов: строка на альбом. pending — сколько файлов пришло с
-- прошлого отправленного уведомления.
create table if not exists public.tg_media_pings (
  album_id  uuid primary key references albums(id) on delete cascade,
  pending   int not null default 0,
  last_sent timestamptz
);
alter table public.tg_media_pings enable row level security;   -- политик нет: только триггер
revoke all on public.tg_media_pings from anon, authenticated;

/**
 * Файл в альбом положил не автор — сказать владельцу платформы. Не чаще раза
 * в 30 минут на альбом: первое сообщение уходит сразу, остальные копятся и
 * досылаются счётчиком при следующем пинге.
 */
create or replace function public.trg_notify_album_media()
returns trigger language plpgsql security definer set search_path = public as $$
declare a albums; uploader uuid; cur tg_media_pings;
begin
  select * into a from albums where id = new.album_id;
  select owner_id into uploader from media where id = new.media_id;
  if a.id is null or uploader is null or uploader = a.author_id then return new; end if;

  insert into tg_media_pings (album_id, pending) values (a.id, 1)
  on conflict (album_id) do update set pending = tg_media_pings.pending + 1
  returning * into cur;

  if cur.last_sent is null or cur.last_sent < now() - interval '30 minutes' then
    update tg_media_pings set pending = 0, last_sent = now() where album_id = a.id;
    perform notify_telegram(
      '📸 Новое медиа в альбоме «' || left(a.title, 120) || '»' ||
      case when cur.pending > 1
           then chr(10) || 'и ещё ' || (cur.pending - 1) || ' с прошлого уведомления'
           else '' end);
  end if;
  return new;
exception when others then
  return new;   -- уведомление не должно ронять загрузку
end $$;

drop trigger if exists trg_notify_album_media_t on public.album_media;
create trigger trg_notify_album_media_t after insert on public.album_media
  for each row execute function public.trg_notify_album_media();

-- ---------------------------------------------------------------- уборка анонимов

-- От удалённых гостей остаётся только число: когда убирали и сколько убрали.
create table if not exists public.anon_cleanup_log (
  id      bigint generated always as identity primary key,
  ran_at  timestamptz not null default now(),
  deleted int not null
);
alter table public.anon_cleanup_log enable row level security;   -- политик нет
revoke all on public.anon_cleanup_log from anon, authenticated;

/**
 * Удаляет анонимные аккаунты старше p_min_age БЕЗ контента: ни файлов, ни
 * комментариев, ни постов. Каскад auth.users -> profiles -> лайки/сохранёнки/
 * строки участника подчищается сам. Аноним С файлами живёт, пока файлы живы
 * (или пока их не заберут через guest_claim).
 */
create or replace function public.cleanup_anon_users(p_min_age interval default interval '30 days')
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with victims as (
    select u.id from auth.users u
    where coalesce(u.is_anonymous, false)
      and u.created_at < now() - p_min_age
      and not exists (select 1 from media m where m.owner_id = u.id)
      and not exists (select 1 from comments c where c.author_id = u.id)
      and not exists (select 1 from posts p where p.author_id = u.id)
  )
  delete from auth.users u using victims v where u.id = v.id;
  get diagnostics n = row_count;

  if n > 0 then
    insert into anon_cleanup_log (deleted) values (n);
  end if;
  return n;
end $$;

revoke execute on function public.trg_notify_new_user()                  from public, anon, authenticated;
revoke execute on function public.trg_notify_album_media()               from public, anon, authenticated;
revoke execute on function public.cleanup_anon_users(interval)           from public, anon, authenticated;

-- Раз в сутки, в тихое время. cron.schedule с тем же именем обновляет job.
select cron.schedule('cleanup-anon-users', '0 4 * * *',
  $$select public.cleanup_anon_users()$$);
