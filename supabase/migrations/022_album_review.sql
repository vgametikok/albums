-- =====================================================================
-- 022: предварительная модерация альбомов.
--
-- Новый порядок: любой альбом, опубликованный после этой миграции, попадает
-- в очередь ручной проверки и посторонним не виден, пока модератор его не
-- одобрит. Автор всё это время видит его у себя с пометкой «на модерации»,
-- соавторы и гости событийного альбома — тоже (иначе свадебный альбом
-- переставал бы работать до пробуждения модератора).
--
-- ВНИМАНИЕ ПРО ЯДРО: здесь переопределяется can_view_album. С этого момента
-- ЕДИНСТВЕННЫЙ источник её полного тела — ЭТА миграция, а не 015. Правило
-- прежнее: следующая правка ядра переписывает тело целиком в одном месте,
-- иначе ветки молча стирают друг друга (см. шапку PLAN.md).
-- =====================================================================

alter table public.albums add column if not exists moderation_status text not null default 'pending';
alter table public.albums add column if not exists reviewed_at timestamptz;
alter table public.albums add column if not exists review_note text;

do $$ begin
  alter table public.albums add constraint albums_moderation_chk
    check (moderation_status in ('pending','approved','rejected'));
exception when duplicate_object then null; end $$;

-- Всё, что уже жило на сайте до введения проверки, считается одобренным:
-- задним числом прятать опубликованное нельзя.
update public.albums set moderation_status = 'approved', reviewed_at = now()
 where moderation_status = 'pending' and created_at < now();

create index if not exists albums_pending_idx on public.albums (published_at)
  where moderation_status = 'pending';

-- Тариф и бан правит только сервисный ключ; статус проверки — тем более.
-- Политика albums_upd разрешает автору менять любую колонку своей строки,
-- поэтому без этого триггера можно было бы одобрить себя самому.
create or replace function public.trg_album_review_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text;
begin
  begin
    r := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  exception when others then r := null;
  end;
  if coalesce(r, 'service_role') <> 'service_role' then
    new.moderation_status := old.moderation_status;
    new.reviewed_at       := old.reviewed_at;
    new.review_note       := old.review_note;
  end if;
  return new;
end $$;

drop trigger if exists trg_albums_review_guard on public.albums;
create trigger trg_albums_review_guard before update on public.albums
  for each row execute function public.trg_album_review_guard();

-- ---------------------------------------------------------------- ядро видимости

/**
 * Полное тело: владелец → соавтор/гость события → обычный зритель.
 * Единственное отличие от версии 015 — у обычного зрителя добавлено условие
 * moderation_status = 'approved'.
 */
create or replace function public.can_view_album(a_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from albums a
    where a.id = a_id and (
      -- 1. владелец: всегда и без каких-либо условий
      a.author_id = viewer
      -- 2. соавтор или гость события
      or (viewer is not null
          and exists (select 1 from album_collaborators c
                      where c.album_id = a.id and c.user_id = viewer)
          and not is_blocked_between(a.author_id, viewer))
      -- 3. обычный зритель
      or (a.published_at is not null
          and a.hidden_at is null
          and a.moderation_status = 'approved'
          and not is_banned(a.author_id)
          and not exists (select 1 from profiles p where p.id = a.author_id and p.deleted_at is not null)
          and not is_blocked_between(a.author_id, viewer)
          and (a.visibility = 'public'
               or (a.visibility = 'friends'
                   and are_friends(a.author_id, viewer)
                   and not exists (select 1 from album_exceptions e
                                   where e.album_id = a.id and e.user_id = viewer))))
    ));
$$;

-- ---------------------------------------------------------------- свой статус

/** Статусы проверки моих альбомов — для пометок в профиле и редакторе. */
create or replace function public.my_album_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(a.id, jsonb_build_object(
           'status', a.moderation_status, 'note', a.review_note)), '{}'::jsonb)
  from albums a where a.author_id = auth.uid();
$$;

-- ---------------------------------------------------------------- очередь модератора

/** Альбомы, ждущие проверки: опубликованы автором, но ещё не одобрены. */
create or replace function public.mod_pending_albums(p_limit int default 50, p_offset int default 0)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'published_at'), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', a.id, 'title', a.title, 'description', a.description,
      'category', a.category, 'visibility', a.visibility::text,
      'published_at', a.published_at,
      'author', p.username, 'author_name', p.display_name,
      'author_banned', p.banned_at is not null,
      'photos', a.photos_count, 'videos', a.videos_count, 'audio', a.audio_count,
      'reports', (select count(*) from reports r
                  where r.subject_type = 'album' and r.subject_id = a.id)) as x
    from albums a join profiles p on p.id = a.author_id
    where a.moderation_status = 'pending' and a.published_at is not null
    order by a.published_at
    limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset)) s;
$$;

/** Решение модератора. Отклонённому автору уходит уведомление. */
create or replace function public.mod_review_album(
  p_album uuid, p_approve boolean, p_login text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  update albums
     set moderation_status = case when p_approve then 'approved' else 'rejected' end,
         reviewed_at = now(),
         review_note = p_note
   where id = p_album
   returning author_id into owner;
  if owner is null then return jsonb_build_object('error', 'no_album'); end if;

  insert into mod_actions (login, action, subject_type, subject_id, note)
  values (p_login, case when p_approve then 'approve' else 'reject' end, 'album', p_album, p_note);

  if not p_approve then
    perform notify_user(owner, 'moderation_action', null, 'album', p_album, null,
                        'moderation_action:' || p_album::text);
  end if;
  return jsonb_build_object('ok', true, 'status', case when p_approve then 'approved' else 'rejected' end);
end $$;

/** Сколько альбомов ждёт проверки — для бейджа во вкладке. */
create or replace function public.mod_pending_count()
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from albums where moderation_status = 'pending' and published_at is not null;
$$;

-- ---------------------------------------------------------------- гранты

revoke execute on function public.mod_pending_albums(int,int)          from public, anon, authenticated;
revoke execute on function public.mod_review_album(uuid,boolean,text,text) from public, anon, authenticated;
revoke execute on function public.mod_pending_count()                  from public, anon, authenticated;
revoke execute on function public.trg_album_review_guard()             from public, anon, authenticated;
revoke execute on function public.my_album_status()                    from public, anon, authenticated;

grant execute on function public.my_album_status() to authenticated;
-- can_view_album вызывается из RLS-политик под ролью вызывающего — нужен anon.
grant execute on function public.can_view_album(uuid,uuid) to anon, authenticated;
