-- 013: уведомления.
--
-- Принцип приватности: в строке уведомления НЕТ ни заголовков, ни текстов —
-- только идентификаторы. Право видеть объект перепроверяется в момент ЧТЕНИЯ
-- списка. Поэтому если альбом стал приватным, дружбу разорвали или автора
-- заблокировали — уведомление просто исчезает, а не показывает то, чего нельзя.
--
-- Дедупликация: пока уведомление не прочитано, повторные события с тем же
-- ключом схлопываются в одну строку со счётчиком («Аня и ещё 3»).

create table if not exists notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  actor_id      uuid references profiles(id) on delete cascade,
  last_actor_id uuid references profiles(id) on delete set null,
  actor_count   int not null default 1 check (actor_count >= 1),
  type text not null check (type in (
    'friend_request','friend_accepted','new_follower',
    'comment_album','comment_post','comment_reply',
    'collab_added','album_upload','post_coauthor',
    'moderation_action')),
  subject_type text not null check (subject_type in ('album','post','comment','profile')),
  subject_id   uuid not null,
  context_id   uuid,
  group_key    text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  read_at      timestamptz,
  check (actor_id is null or actor_id <> user_id)
);
create index if not exists notif_user_idx   on notifications(user_id, created_at desc);
create index if not exists notif_unread_idx on notifications(user_id) where read_at is null;
create unique index if not exists notif_group_unread_uq
  on notifications(user_id, group_key) where read_at is null;

alter table notifications enable row level security;
drop policy if exists notif_read on notifications;
drop policy if exists notif_del  on notifications;
create policy notif_read on notifications for select using (user_id = auth.uid());
create policy notif_del  on notifications for delete using (user_id = auth.uid());
-- INSERT/UPDATE политик нет: пишет только definer-код ниже.

create or replace function public.notify_user(
  p_user uuid, p_type text, p_actor uuid,
  p_subject_type text, p_subject_id uuid, p_context_id uuid default null,
  p_group_key text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare gk text; nid uuid; n int;
begin
  if p_user is null or p_subject_id is null then return null; end if;
  if p_actor is not null and p_actor = p_user then return null; end if;
  -- заблокированные друг для друга не шлют уведомлений
  if p_actor is not null and is_blocked_between(p_user, p_actor) then return null; end if;

  gk := coalesce(p_group_key, p_type || ':' || p_subject_id::text);

  if p_actor is not null then
    select count(*) into n from notifications
     where user_id = p_user and actor_id = p_actor and created_at > now() - interval '1 hour';
    if n >= 20 then return null; end if;
  end if;
  select count(*) into n from notifications
   where user_id = p_user and created_at > now() - interval '1 hour';
  if n >= 100 then return null; end if;

  update notifications x set
    actor_count   = case when x.last_actor_id is distinct from p_actor then x.actor_count + 1 else x.actor_count end,
    last_actor_id = coalesce(p_actor, x.last_actor_id),
    context_id    = coalesce(p_context_id, x.context_id),
    updated_at    = now()
  where x.user_id = p_user and x.group_key = gk and x.read_at is null
  returning x.id into nid;
  if nid is not null then return nid; end if;

  insert into notifications (user_id, actor_id, last_actor_id, type, subject_type, subject_id, context_id, group_key)
  values (p_user, p_actor, p_actor, p_type, p_subject_type, p_subject_id, p_context_id, gk)
  returning id into nid;
  return nid;
end $$;

-- ---------------------------------------------------------------- источники

create or replace function public.trg_notify_friendship()
returns trigger language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  if TG_OP = 'INSERT' and new.status = 'pending' then
    target := case when new.requested_by = new.user_a then new.user_b else new.user_a end;
    perform notify_user(target, 'friend_request', new.requested_by, 'profile', new.requested_by);
  elsif TG_OP = 'UPDATE' and new.status = 'accepted' and old.status = 'pending' then
    -- принял тот, кто НЕ отправлял
    target := new.requested_by;
    perform notify_user(target, 'friend_accepted',
      case when new.requested_by = new.user_a then new.user_b else new.user_a end,
      'profile', case when new.requested_by = new.user_a then new.user_b else new.user_a end);
  end if;
  return null;
end $$;

drop trigger if exists notify_friendship_t on friendships;
create trigger notify_friendship_t after insert or update on friendships
for each row execute function public.trg_notify_friendship();

create or replace function public.trg_notify_follow()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform notify_user(new.following_id, 'new_follower', new.follower_id, 'profile', new.follower_id);
  return null;
end $$;

drop trigger if exists notify_follow_t on follows;
create trigger notify_follow_t after insert on follows
for each row execute function public.trg_notify_follow();

create or replace function public.trg_notify_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare owner uuid; parent_author uuid;
begin
  if new.subject_type = 'album' then
    select author_id into owner from albums where id = new.subject_id;
    perform notify_user(owner, 'comment_album', new.author_id, 'album', new.subject_id, new.subject_id,
                        'comment_album:' || new.subject_id::text);
  else
    select author_id into owner from posts where id = new.subject_id;
    perform notify_user(owner, 'comment_post', new.author_id, 'post', new.subject_id, new.subject_id,
                        'comment_post:' || new.subject_id::text);
  end if;

  if new.parent_id is not null then
    select author_id into parent_author from comments where id = new.parent_id;
    if parent_author is not null and parent_author <> owner then
      perform notify_user(parent_author, 'comment_reply', new.author_id,
                          new.subject_type::text, new.subject_id, new.subject_id,
                          'comment_reply:' || new.parent_id::text);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists notify_comment_t on comments;
create trigger notify_comment_t after insert on comments
for each row execute function public.trg_notify_comment();

create or replace function public.trg_notify_collab()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- гостей события не поздравляем с «соавторством» — они пришли по ссылке сами
  if new.role = 'editor' then
    perform notify_user(new.user_id, 'collab_added', new.added_by, 'album', new.album_id, new.album_id);
  end if;
  return null;
end $$;

drop trigger if exists notify_collab_t on album_collaborators;
create trigger notify_collab_t after insert on album_collaborators
for each row execute function public.trg_notify_collab();

/** Кто-то дозалил файлы в мой альбом. Схлопывается по альбому и автору. */
create or replace function public.trg_notify_upload()
returns trigger language plpgsql security definer set search_path = public as $$
declare owner uuid; uploader uuid;
begin
  select author_id into owner from albums where id = new.album_id;
  select owner_id into uploader from media where id = new.media_id;
  if owner is null or uploader is null or owner = uploader then return null; end if;
  perform notify_user(owner, 'album_upload', uploader, 'album', new.album_id, new.album_id,
                      'album_upload:' || new.album_id::text);
  return null;
end $$;

drop trigger if exists notify_upload_t on album_media;
create trigger notify_upload_t after insert on album_media
for each row execute function public.trg_notify_upload();

-- ---------------------------------------------------------------- чтение

/** Виден ли объект уведомления ПРЯМО СЕЙЧАС. Заодно отсекает бан и удаление. */
create or replace function public.notif_still_visible(
  p_subject_type text, p_subject_id uuid, p_viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case p_subject_type
    when 'album' then can_view_album(p_subject_id, p_viewer)
    when 'post'  then can_view_post(p_subject_id, p_viewer)
    when 'profile' then exists (
      select 1 from profiles p
      where p.id = p_subject_id and p.banned_at is null and p.deleted_at is null
        and not is_blocked_between(p.id, p_viewer))
    else true end;
$$;

create or replace function public.notif_list(p_limit int default 30, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); res jsonb; stale uuid[];
begin
  if me is null then raise exception 'auth required'; end if;

  -- чистим то, что перестало быть видимым (альбом закрыли, автора заблокировали)
  select array_agg(n.id) into stale from notifications n
   where n.user_id = me and not notif_still_visible(n.subject_type, n.subject_id, me);
  if stale is not null then delete from notifications where id = any(stale); end if;

  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) into res from (
    select jsonb_build_object(
      'id', n.id, 'type', n.type, 'subject_type', n.subject_type, 'subject_id', n.subject_id,
      'context_id', n.context_id, 'actor_count', n.actor_count,
      'created_at', n.updated_at, 'read', n.read_at is not null,
      'actor', case when p.id is null then null else jsonb_build_object(
        'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url) end,
      'album_title', case when n.subject_type = 'album'
        then (select a.title from albums a where a.id = n.subject_id) end
    ) as x
    from notifications n
    left join profiles p on p.id = coalesce(n.last_actor_id, n.actor_id)
    where n.user_id = me
    order by n.updated_at desc
    limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)
  ) s;
  return jsonb_build_object('items', res, 'unread', (
    select count(*) from notifications where user_id = me and read_at is null));
end $$;

create or replace function public.notif_unread_count()
returns int language sql stable security definer set search_path = public as $$
  select coalesce((select count(*)::int from notifications
                   where user_id = auth.uid() and read_at is null), 0);
$$;

create or replace function public.notif_mark_read(p_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth required'; end if;
  if p_id is null then update notifications set read_at = now() where user_id = me and read_at is null;
  else update notifications set read_at = now() where user_id = me and id = p_id and read_at is null; end if;
  return jsonb_build_object('unread', (select count(*) from notifications where user_id = me and read_at is null));
end $$;
