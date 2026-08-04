-- =====================================================================
-- 039: очередь новых медиа в панели модерации.
--
-- Пробел, который закрываем: альбом проверяется ОДИН раз при публикации,
-- а всё, что доливается потом — гостевые фото общих альбомов, дозагрузки
-- соавторов — модератор платформы не видел вообще. Теперь каждый файл,
-- положенный в чужой альбом (или гостем в общий), попадает в очередь
-- «New media» админки. Владелец телеграм-пинг уже получает (038).
--
-- Решения модератора: approve (отметить проверенным) или hide (файл
-- становится private — публика не видит, загрузивший видит своё).
-- =====================================================================

create table if not exists public.mod_media_queue (
  am_id       uuid primary key references album_media(id) on delete cascade,
  album_id    uuid not null references albums(id) on delete cascade,
  media_id    uuid not null references media(id) on delete cascade,
  added_at    timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  decision    text check (decision in ('approved', 'hidden'))
);
create index if not exists mod_media_queue_open_idx on public.mod_media_queue (added_at)
  where reviewed_at is null;
alter table public.mod_media_queue enable row level security;   -- политик нет: только mod-api
revoke all on public.mod_media_queue from anon, authenticated;

/**
 * В очередь попадает файл, который в альбом положил НЕ его автор:
 * гость общего альбома (в любом статусе альбома — приватное событие тоже
 * смотрим) или соавтор уже опубликованного. Свои файлы автора не проверяем
 * повторно: их покрывает проверка альбома при публикации.
 */
create or replace function public.trg_mod_media_enqueue()
returns trigger language plpgsql security definer set search_path = public as $$
declare a albums; uploader uuid;
begin
  select * into a from albums where id = new.album_id;
  select owner_id into uploader from media where id = new.media_id;
  if a.id is null or uploader is null or uploader = a.author_id then return new; end if;
  if not a.is_event and a.published_at is null then return new; end if;

  insert into mod_media_queue (am_id, album_id, media_id) values (new.id, a.id, new.media_id)
  on conflict (am_id) do nothing;
  return new;
exception when others then
  return new;   -- очередь не должна ронять загрузку
end $$;

drop trigger if exists trg_mod_media_enqueue_t on public.album_media;
create trigger trg_mod_media_enqueue_t after insert on public.album_media
  for each row execute function public.trg_mod_media_enqueue();

-- ---------------------------------------------------------------- выдача очереди

create or replace function public.mod_media_pending(p_limit int default 60, p_offset int default 0)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x->>'added_at')), '[]'::jsonb) from (
    select jsonb_build_object(
      'am_id', q.am_id, 'added_at', q.added_at,
      'album_id', a.id, 'album_title', a.title, 'is_event', a.is_event,
      'album_owner', op.username,
      'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
      'duration', m.duration_seconds,
      'caption', am.caption, 'visibility', am.visibility::text,
      'is_private', am.is_private, 'anon', am.anon,
      'uploader', up.username, 'uploader_name', up.display_name,
      'uploader_guest', exists (select 1 from auth.users u
                                where u.id = m.owner_id and coalesce(u.is_anonymous, false)),
      'reports', (select count(*) from reports r
                  where r.subject_type = 'album' and r.subject_id = a.id)) as x
    from mod_media_queue q
    join album_media am on am.id = q.am_id
    join media m on m.id = q.media_id
    join albums a on a.id = q.album_id
    join profiles op on op.id = a.author_id
    left join profiles up on up.id = m.owner_id
    where q.reviewed_at is null
    order by q.added_at
    limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset)) s;
$$;

create or replace function public.mod_media_count()
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from mod_media_queue where reviewed_at is null;
$$;

/** Решение: approve — файл проверен; hide — файл становится private. */
create or replace function public.mod_media_review(
  p_am_id uuid, p_approve boolean, p_login text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q mod_media_queue;
begin
  select * into q from mod_media_queue where am_id = p_am_id and reviewed_at is null;
  if not found then return jsonb_build_object('error', 'not_in_queue'); end if;

  if not p_approve then
    update album_media set visibility = 'private' where id = p_am_id;
  end if;

  update mod_media_queue
     set reviewed_at = now(), reviewed_by = p_login,
         decision = case when p_approve then 'approved' else 'hidden' end
   where am_id = p_am_id;

  insert into mod_actions (login, action, subject_type, subject_id, note)
  values (p_login, case when p_approve then 'approve' else 'hide' end, 'album', q.album_id,
          'media ' || q.media_id::text);

  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- добор: гостевое, залитое до 039

-- У album_media нет created_at — датой попадания в очередь считаем дату файла.
insert into mod_media_queue (am_id, album_id, media_id, added_at)
select am.id, am.album_id, am.media_id, m.created_at
  from album_media am
  join media m on m.id = am.media_id
  join albums a on a.id = am.album_id
 where m.owner_id <> a.author_id
   and (a.is_event or a.published_at is not null)
on conflict (am_id) do nothing;

-- Всё гостевое, что уже давно живёт на сайте и было разобрано владельцами,
-- не заставляем проверять задним числом: помечаем проверенным всё старше суток.
update mod_media_queue set reviewed_at = now(), reviewed_by = 'backfill', decision = 'approved'
 where reviewed_at is null and added_at < now() - interval '1 day';

-- ---------------------------------------------------------------- гранты

revoke execute on function public.trg_mod_media_enqueue()            from public, anon, authenticated;
revoke execute on function public.mod_media_pending(int, int)        from public, anon, authenticated;
revoke execute on function public.mod_media_count()                  from public, anon, authenticated;
revoke execute on function public.mod_media_review(uuid, boolean, text) from public, anon, authenticated;
