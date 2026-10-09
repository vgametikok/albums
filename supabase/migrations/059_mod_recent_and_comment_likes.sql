-- =====================================================================
-- 059: (1) админка — ленты «последние альбомы» и «последние медиа» с
--      решением в любой момент; (2) лайки комментариев с «сердечком автора».
--
-- (1) Модератор видит всё свежее независимо от статуса (одобрено вручную,
--     одобрено автоматически, ждёт, скрыто/отклонено) и может передумать:
--       • альбом — прежние действия mod-api: review (mod_review_album),
--         hide (mod_hide), ban (mod_ban);
--       • файл — новая mod_media_set: approve/hide в любой момент, даже если
--         файл уже разобран или в очередь не попадал (залит до 058).
--     mod_media_review (очередь New media) теперь сводится к mod_media_set,
--     поэтому оба пути ведут себя одинаково. Все решения — в mod_actions.
--     Для лент нужен передеплой mod-api (действия mod_recent_albums,
--     mod_recent_media, media_set).
--
-- (2) comment_likes: лайкнуть/снять лайк может любой вошедший, один раз.
--     Видно лайки там же, где виден сам комментарий (политика читает через
--     comments, а у той — своя RLS). Счётчик и флаг «лайкнул автор альбома/
--     поста» лежат прямо в comments (likes_count, creator_heart) и
--     пересчитываются триггером; руками их не поправить — страж ниже.
--
-- Идемпотентна.
-- =====================================================================

-- ---------------------------------------------------------------- индексы под ленты

create index if not exists albums_created_idx      on public.albums (created_at desc);
create index if not exists media_created_idx       on public.media (created_at desc);
create index if not exists mod_actions_subject_idx on public.mod_actions (subject_id, created_at desc);

-- ---------------------------------------------------------------- 1. решение по файлу в любой момент

/**
 * approve — файл виден по своей видимости; hide — файл private (публика не
 * видит, загрузивший — видит своё). Работает для любой строки album_media:
 * придержанной, уже разобранной, залитой до 058 (тогда заводится строка
 * очереди, чтобы решение было видно в лентах и учитывалось mod_cover_ok).
 *
 * Видимость при скрытии сохраняется в mod_hold_vis, и повторное одобрение
 * возвращает её (а не делает файл открытым всем).
 */
create or replace function public.mod_media_set(p_am_id uuid, p_approve boolean, p_login text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare am album_media; q mod_media_queue; was text;
begin
  select * into am from album_media where id = p_am_id;
  if am.id is null then return jsonb_build_object('error', 'not_found'); end if;

  select * into q from mod_media_queue where am_id = p_am_id;
  was := case when am.mod_hold or (q.am_id is not null and q.reviewed_at is null) then 'pending'
              when q.am_id is null then 'auto'
              else coalesce(q.decision, 'approved') end;
  if q.am_id is null then
    insert into mod_media_queue (am_id, album_id, media_id, added_at)
    values (am.id, am.album_id, am.media_id, now())
    on conflict (am_id) do nothing;
    select * into q from mod_media_queue where am_id = p_am_id;
  end if;

  perform set_config('albums.mod_release', 'on', true);
  if p_approve then
    if am.mod_hold or coalesce(q.decision, '') = 'hidden' then
      update album_media set mod_hold = false, visibility = mod_hold_vis, mod_hold_vis = null
       where id = p_am_id;
    end if;
  else
    if am.mod_hold or coalesce(q.decision, '') <> 'hidden' then
      update album_media
         set mod_hold_vis = case when am.mod_hold then am.mod_hold_vis else am.visibility end,
             mod_hold = false, visibility = 'private'
       where id = p_am_id;
    end if;
  end if;
  perform set_config('albums.mod_release', '', true);

  update mod_media_queue
     set reviewed_at = now(), reviewed_by = p_login,
         decision = case when p_approve then 'approved' else 'hidden' end
   where am_id = p_am_id;

  insert into mod_actions (login, action, subject_type, subject_id, note)
  values (p_login, case when p_approve then 'approve' else 'hide' end, 'album', am.album_id,
          'media ' || am.media_id::text || ' (was ' || was || ')');
  return jsonb_build_object('ok', true, 'status', case when p_approve then 'approved' else 'hidden' end);
end $$;

/** Очередь New media (058): та же логика, но только по открытой заявке. */
create or replace function public.mod_media_review(
  p_am_id uuid, p_approve boolean, p_login text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c mod_cover_queue;
begin
  if exists (select 1 from mod_media_queue where am_id = p_am_id and reviewed_at is null) then
    return mod_media_set(p_am_id, p_approve, p_login);
  end if;

  select * into c from mod_cover_queue where id = p_am_id and reviewed_at is null;
  if not found then return jsonb_build_object('error', 'not_in_queue'); end if;
  update mod_cover_queue
     set reviewed_at = now(), reviewed_by = p_login,
         decision = case when p_approve then 'approved' else 'hidden' end
   where id = p_am_id;
  insert into mod_actions (login, action, subject_type, subject_id, note)
  values (p_login, case when p_approve then 'approve' else 'hide' end, 'album', c.album_id,
          'cover ' || c.media_id::text);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- 1. скрытое остаётся скрытым

/**
 * Полное тело придержки (прошлое — 058) + ветка для скрытых модератором:
 * раньше автор мог вернуть скрытому файлу видимость обычной правкой строки.
 */
create or replace function public.trg_album_media_mod_hold()
returns trigger language plpgsql security definer set search_path = public as $$
declare a_event boolean; a_pub timestamptz;
begin
  if coalesce(current_setting('albums.mod_release', true), '') = 'on' then return new; end if;

  if tg_op = 'INSERT' then
    new.mod_hold := false;
    new.mod_hold_vis := null;
    -- уже проверенный файл (копия из библиотеки, спутник события) — не держим
    if mod_media_is_approved(new.media_id, new.album_id) then return new; end if;
    -- приватное (неопубликованное) событие: видят только участники — не держим,
    -- но в очередь кадр уйдёт (trg_mod_media_enqueue)
    select a.is_event, a.published_at into a_event, a_pub from albums a where a.id = new.album_id;
    if coalesce(a_event, false) and a_pub is null then return new; end if;

    new.mod_hold_vis := new.visibility;
    new.mod_hold := true;
    new.visibility := 'private';
    new.is_private := true;
    return new;
  end if;

  -- UPDATE
  -- подмена файла в уже одобренной строке (приложение так не делает, но
  -- прямой PATCH через PostgREST может): новый файл проходит проверку заново
  if new.media_id is distinct from old.media_id and not mod_media_is_approved(new.media_id, null) then
    if not old.mod_hold then new.mod_hold_vis := new.visibility; end if;
    new.mod_hold := true;
    new.visibility := 'private';
    new.is_private := true;
    insert into mod_media_queue (am_id, album_id, media_id) values (new.id, new.album_id, new.media_id)
    on conflict (am_id) do update
      set media_id = excluded.media_id, added_at = now(),
          reviewed_at = null, reviewed_by = null, decision = null;
    return new;
  end if;

  if old.mod_hold then
    -- автор/редактор меняет видимость придержанного кадра: запоминаем выбор,
    -- но кадр остаётся закрытым до решения модератора
    if new.visibility is distinct from old.visibility then
      new.mod_hold_vis := new.visibility;
    else
      new.mod_hold_vis := old.mod_hold_vis;
    end if;
    new.mod_hold := true;
    new.visibility := 'private';
    new.is_private := true;
  elsif exists (select 1 from mod_media_queue q where q.am_id = new.id and q.decision = 'hidden') then
    -- 059: скрытый модератором файл автор не открывает сменой видимости —
    -- выбор запоминается и вернётся, если модератор передумает
    if new.visibility is distinct from old.visibility then
      new.mod_hold_vis := new.visibility;
    else
      new.mod_hold_vis := old.mod_hold_vis;
    end if;
    new.mod_hold := false;
    new.visibility := 'private';
    new.is_private := true;
  else
    -- самому себе придержку не ставят и чужую цель не подменяют
    new.mod_hold := false;
    new.mod_hold_vis := old.mod_hold_vis;
  end if;
  return new;
end $$;


-- ---------------------------------------------------------------- 1. ленты

/**
 * Последние созданные альбомы, новые сверху. p_status: all | approved |
 * auto | pending | rejected | hidden | draft.
 *   auto     — одобрен, и последнее решение по альбому принял 'system' (058);
 *   approved — одобрен человеком (или до 058);
 *   hidden   — скрыт модератором (hidden_at), поверх любого статуса.
 */
create or replace function public.mod_recent_albums(
  p_status text default 'all', p_limit int default 30, p_offset int default 0)
returns jsonb language sql stable security definer set search_path = public as $$
  with base as (
    select a.*, p.username, p.display_name, p.avatar_url, p.banned_at as author_banned_at,
           la.login as decided_by, la.action as decided_action, la.created_at as decided_at,
           case when a.hidden_at is not null then 'hidden'
                when a.moderation_status = 'rejected' then 'rejected'
                when a.moderation_status = 'pending' then 'pending'
                when la.login = 'system' then 'auto'
                else 'approved' end as status
      from albums a
      join profiles p on p.id = a.author_id
      left join lateral (
        select m.login, m.action, m.created_at from mod_actions m
         where m.subject_id = a.id and m.subject_type = 'album'
           and m.action in ('approve', 'reject', 'hide', 'unhide')
           and coalesce(m.note, '') not like 'media %' and coalesce(m.note, '') not like 'cover %'
         order by m.created_at desc limit 1) la on true),
  f as (
    select * from base
     where case coalesce(p_status, 'all')
             when 'all' then true
             when 'draft' then published_at is null
             else status = p_status end)
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((
      select jsonb_agg(x order by created_at desc) from (
        select f.created_at, jsonb_build_object(
          'id', f.id, 'title', f.title, 'description', left(f.description, 200),
          'created_at', f.created_at, 'published_at', f.published_at,
          'visibility', f.visibility::text, 'is_event', f.is_event,
          'moderation_status', f.moderation_status, 'hidden_at', f.hidden_at,
          'status', f.status, 'decided_by', f.decided_by, 'decided_action', f.decided_action,
          'decided_at', f.decided_at, 'review_note', f.review_note,
          'author_id', f.author_id, 'author', f.username, 'author_name', f.display_name,
          'author_avatar', f.avatar_url, 'author_banned', f.author_banned_at is not null,
          'files', (select count(*) from album_media am where am.album_id = f.id),
          'held', (select count(*) from album_media am where am.album_id = f.id and am.mod_hold),
          'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = f.cover_media_id),
          'reports', (select count(*) from reports r where r.subject_type = 'album' and r.subject_id = f.id)) as x
        from f order by f.created_at desc
        limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)) s), '[]'::jsonb));
$$;

/**
 * Последние загруженные файлы альбомов (по времени загрузки файла), новые
 * сверху. p_status: all | pending | approved | auto | hidden.
 *   pending  — придержан или ждёт в очереди;
 *   approved — одобрен модератором;
 *   hidden   — скрыт модератором;
 *   auto     — проверки не было: залит до 058 или уже одобренный файл.
 */
create or replace function public.mod_recent_media(
  p_status text default 'all', p_limit int default 48, p_offset int default 0)
returns jsonb language sql stable security definer set search_path = public as $$
  with base as (
    select am.id as am_id, am.album_id, am.media_id, am.caption, am.mod_hold, am.anon,
           am.visibility, am.mod_hold_vis, am.is_private,
           m.kind, m.storage_path, m.thumb_path, m.duration_seconds, m.created_at, m.owner_id,
           a.title as album_title, a.author_id, a.is_event, a.published_at as album_published_at,
           q.reviewed_by, q.reviewed_at, q.decision,
           case when am.mod_hold or (q.am_id is not null and q.reviewed_at is null) then 'pending'
                when q.decision = 'hidden' then 'hidden'
                when q.decision = 'approved' then 'approved'
                else 'auto' end as status
      from album_media am
      join media m on m.id = am.media_id
      join albums a on a.id = am.album_id
      left join mod_media_queue q on q.am_id = am.id),
  f as (select * from base where coalesce(p_status, 'all') = 'all' or status = p_status)
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((
      select jsonb_agg(x order by created_at desc, am_id) from (
        select f.created_at, f.am_id, jsonb_build_object(
          'am_id', f.am_id, 'media_id', f.media_id, 'kind', f.kind,
          'path', f.storage_path, 'thumb', f.thumb_path, 'duration', f.duration_seconds,
          'created_at', f.created_at, 'caption', f.caption, 'status', f.status,
          'decided_by', f.reviewed_by, 'decided_at', f.reviewed_at,
          'held', f.mod_hold,
          'owner_private', case when f.mod_hold then coalesce(f.mod_hold_vis in ('friends', 'private'), false)
                                when f.decision = 'hidden' then false
                                else f.is_private end,
          'album_id', f.album_id, 'album_title', f.album_title, 'is_event', f.is_event,
          'album_published', f.album_published_at is not null,
          'author_id', f.author_id, 'author', ap.username,
          'uploader_id', f.owner_id, 'uploader', up.username, 'uploader_name', up.display_name,
          'uploader_banned', up.banned_at is not null,
          'uploader_is_author', f.owner_id = f.author_id,
          'uploader_guest', exists (select 1 from auth.users u
                                    where u.id = f.owner_id and coalesce(u.is_anonymous, false))) as x
        from f
        left join profiles ap on ap.id = f.author_id
        left join profiles up on up.id = f.owner_id
        order by f.created_at desc, f.am_id
        limit greatest(1, least(p_limit, 120)) offset greatest(0, p_offset)) s), '[]'::jsonb));
$$;

revoke execute on function public.mod_media_set(uuid, boolean, text)       from public, anon, authenticated;
revoke execute on function public.mod_media_review(uuid, boolean, text)    from public, anon, authenticated;
revoke execute on function public.mod_recent_albums(text, int, int)        from public, anon, authenticated;
revoke execute on function public.mod_recent_media(text, int, int)         from public, anon, authenticated;

-- ---------------------------------------------------------------- 2. лайки комментариев

alter table public.comments add column if not exists likes_count   int not null default 0;
alter table public.comments add column if not exists creator_heart boolean not null default false;

create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index if not exists comment_likes_user_idx on public.comment_likes (user_id);
alter table public.comment_likes enable row level security;

-- Видно — если виден сам комментарий (подзапрос идёт через RLS comments).
drop policy if exists comment_likes_read on public.comment_likes;
create policy comment_likes_read on public.comment_likes for select
  using (exists (select 1 from comments c where c.id = comment_id));
-- Ставит и снимает только свой лайк, и только на видимый комментарий.
drop policy if exists comment_likes_ins on public.comment_likes;
create policy comment_likes_ins on public.comment_likes for insert
  with check (user_id = auth.uid() and exists (select 1 from comments c where c.id = comment_id));
drop policy if exists comment_likes_del on public.comment_likes;
create policy comment_likes_del on public.comment_likes for delete
  using (user_id = auth.uid());

revoke all on public.comment_likes from anon;
grant select on public.comment_likes to anon;
grant select, insert, delete on public.comment_likes to authenticated;

/** Счётчик и «сердечко автора» пересчитываются после каждого лайка/снятия. */
create or replace function public.trg_comment_likes_sync()
returns trigger language plpgsql security definer set search_path = public as $$
declare cid uuid := coalesce(new.comment_id, old.comment_id); c comments; owner uuid;
begin
  select * into c from comments where id = cid;
  if c.id is null then return null; end if;   -- комментарий удаляется каскадом
  owner := case c.subject_type
             when 'album' then (select author_id from albums where id = c.subject_id)
             when 'post'  then (select author_id from posts  where id = c.subject_id)
           end;
  update comments
     set likes_count   = (select count(*) from comment_likes l where l.comment_id = cid),
         creator_heart = owner is not null
                         and exists (select 1 from comment_likes l where l.comment_id = cid and l.user_id = owner)
   where id = cid;
  return null;
end $$;

drop trigger if exists comment_likes_sync_t on public.comment_likes;
create trigger comment_likes_sync_t after insert or delete on public.comment_likes
  for each row execute function public.trg_comment_likes_sync();

/**
 * Страж: автор комментария может править свою строку (comments_upd), но не
 * счётчик лайков и не «сердечко». Писать их можно только из триггера выше
 * (глубина триггеров > 1) или сервисным ключом / SQL-редактором.
 */
create or replace function public.trg_comment_like_fields_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  begin
    r := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  exception when others then r := null;
  end;
  if coalesce(r, 'service_role') = 'service_role' then return new; end if;
  if tg_op = 'INSERT' then
    new.likes_count := 0; new.creator_heart := false;
  else
    new.likes_count := old.likes_count; new.creator_heart := old.creator_heart;
  end if;
  return new;
end $$;

drop trigger if exists comments_like_fields_guard_t on public.comments;
create trigger comments_like_fields_guard_t before insert or update on public.comments
  for each row execute function public.trg_comment_like_fields_guard();

revoke execute on function public.trg_comment_likes_sync()        from public, anon, authenticated;
revoke execute on function public.trg_comment_like_fields_guard() from public, anon, authenticated;

-- пересчёт на случай повторного запуска (счётчики сходятся с таблицей)
update public.comments c
   set likes_count = s.n
  from (select comment_id, count(*)::int n from public.comment_likes group by comment_id) s
 where s.comment_id = c.id and c.likes_count <> s.n;
