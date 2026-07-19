-- 1) Приватность отдельных файлов внутри альбома
-- 2) Совместные альбомы (соавторы из числа друзей)

-- ============================================================ схема

alter table album_media add column if not exists is_private boolean not null default false;

create table if not exists album_collaborators (
  album_id   uuid not null references albums(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  added_by   uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (album_id, user_id)
);
create index if not exists album_collab_user_idx on album_collaborators(user_id);
alter table album_collaborators enable row level security;

-- ============================================================ права

/** Кто может ПРАВИТЬ содержимое альбома: владелец и соавторы. */
create or replace function public.can_edit_album(a_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from albums where id = a_id and author_id = auth.uid())
      or exists (select 1 from album_collaborators where album_id = a_id and user_id = auth.uid());
$$;

/** Владелец альбома (только он меняет видимость, соавторов и удаляет альбом). */
create or replace function public.is_album_owner(a_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from albums where id = a_id and author_id = auth.uid());
$$;

-- Соавторы видят альбом всегда, даже приватный и черновик.
create or replace function public.can_view_album(a_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from albums a
    where a.id = a_id and (
      a.author_id = viewer
      or (viewer is not null and exists (
            select 1 from album_collaborators c where c.album_id = a.id and c.user_id = viewer))
      or (a.published_at is not null and (
        a.visibility = 'public'
        or (a.visibility = 'friends'
            and are_friends(a.author_id, viewer)
            and not exists (select 1 from album_exceptions e
                            where e.album_id = a.id and e.user_id = viewer))
      ))
    )
  );
$$;

-- Файл, помеченный приватным в альбоме, доступен только тем, кто правит альбом.
create or replace function public.can_view_media(m_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from media where id = m_id and owner_id = viewer)
      or exists (select 1 from album_media am
                 where am.media_id = m_id and not am.is_private
                   and can_view_album(am.album_id, viewer))
      or exists (select 1 from album_media am
                 where am.media_id = m_id and am.is_private
                   and (exists (select 1 from albums a where a.id = am.album_id and a.author_id = viewer)
                        or exists (select 1 from album_collaborators c
                                   where c.album_id = am.album_id and c.user_id = viewer)))
      or exists (select 1 from albums al
                 where al.cover_media_id = m_id and can_view_album(al.id, viewer)
                   and not exists (select 1 from album_media am2
                                   where am2.album_id = al.id and am2.media_id = m_id and am2.is_private))
      or exists (select 1 from post_media pm where pm.media_id = m_id and can_view_post(pm.post_id, viewer));
$$;

-- ============================================================ политики

drop policy if exists chapters_all on album_chapters;
create policy chapters_all on album_chapters for all
  using (can_edit_album(album_id)) with check (can_edit_album(album_id));

drop policy if exists amedia_all on album_media;
create policy amedia_all on album_media for all
  using (can_edit_album(album_id)) with check (can_edit_album(album_id));

-- соавтор может править карточку альбома; чувствительные поля стережёт триггер ниже
drop policy if exists albums_upd on albums;
create policy albums_upd on albums for update
  using (author_id = auth.uid() or can_edit_album(id))
  with check (author_id = auth.uid() or can_edit_album(id));

drop policy if exists albums_del on albums;
create policy albums_del on albums for delete using (author_id = auth.uid());

drop policy if exists collab_read on album_collaborators;
create policy collab_read on album_collaborators for select
  using (can_view_album(album_id, auth.uid()));
-- запись только через RPC

-- Видимость, закрепление, автора и исключения меняет только владелец.
create or replace function public.trg_album_owner_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.author_id <> old.author_id
     or new.visibility is distinct from old.visibility
     or new.is_pinned is distinct from old.is_pinned then
    if not exists (select 1 from albums where id = old.id and author_id = auth.uid()) then
      raise exception 'Только владелец альбома может менять видимость и закрепление';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists albums_owner_fields_t on albums;
create trigger albums_owner_fields_t before update on albums
for each row execute function public.trg_album_owner_fields();

-- Счётчики считают только непубличные-исключённые: наружу показываем то, что видно.
create or replace function public.trg_album_media_counts()
returns trigger language plpgsql security definer set search_path = public as $$
declare aid uuid;
begin
  aid := coalesce(new.album_id, old.album_id);
  update albums a set
    photos_count = (select count(*) from album_media am join media m on m.id=am.media_id
                    where am.album_id=aid and m.kind='photo' and not am.is_private),
    videos_count = (select count(*) from album_media am join media m on m.id=am.media_id
                    where am.album_id=aid and m.kind='video' and not am.is_private),
    audio_count  = (select count(*) from album_media am join media m on m.id=am.media_id
                    where am.album_id=aid and m.kind='audio' and not am.is_private),
    updated_at = now()
  where a.id = aid;
  return null;
end $$;

drop trigger if exists album_media_counts_t on album_media;
create trigger album_media_counts_t after insert or update or delete on album_media
for each row execute function public.trg_album_media_counts();

-- ============================================================ RPC соавторства

create or replace function public.album_collaborator_add(p_album uuid, p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); target uuid; owner uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select author_id into owner from albums where id = p_album;
  if owner is null then raise exception 'Альбом не найден'; end if;
  if owner <> me then raise exception 'Соавторов добавляет только владелец альбома'; end if;

  select id into target from profiles where username = lower(p_username);
  if target is null then raise exception 'Пользователь не найден'; end if;
  if target = me then raise exception 'Вы и так владелец'; end if;
  if not are_friends(me, target) then raise exception 'Соавтором можно сделать только друга'; end if;

  insert into album_collaborators (album_id, user_id, added_by)
  values (p_album, target, me) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.album_collaborator_remove(p_album uuid, p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); target uuid; owner uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select author_id into owner from albums where id = p_album;
  select id into target from profiles where username = lower(p_username);
  if target is null then raise exception 'Пользователь не найден'; end if;
  -- убрать соавтора может владелец, либо соавтор сам себя
  if owner <> me and target <> me then raise exception 'Недостаточно прав'; end if;
  delete from album_collaborators where album_id = p_album and user_id = target;
  return jsonb_build_object('ok', true);
end $$;

/** Альбомы, где я соавтор (для раздела «Совместные» в профиле). */
create or replace function public.my_shared_albums()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'title', a.title, 'category', a.category, 'visibility', a.visibility,
      'published_at', a.published_at,
      'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
      'views_count', a.views_count, 'likes_count', a.likes_count,
      'owner_username', p.username, 'owner_name', p.display_name,
      'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id),
      'thumb1', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                 where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1),
      'thumb2', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                 where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1 offset 1)
    ) order by a.updated_at desc)
    from album_collaborators c
    join albums a on a.id = c.album_id
    join profiles p on p.id = a.author_id
    where c.user_id = auth.uid()), '[]'::jsonb);
$$;

/** Своя медиатека — для выбора уже загруженного при создании поста. */
create or replace function public.my_media(p_kind text default null, p_limit int default 60, p_offset int default 0)
returns table (id uuid, kind media_kind, storage_path text, thumb_path text,
               width int, height int, duration_seconds numeric, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.kind, m.storage_path, m.thumb_path, m.width, m.height, m.duration_seconds, m.created_at
  from media m
  where m.owner_id = auth.uid()
    and (p_kind is null or m.kind::text = p_kind)
  order by m.created_at desc
  limit greatest(1, least(p_limit, 120)) offset greatest(0, p_offset);
$$;

-- ============================================================ выдача альбома

create or replace function public.get_album(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not can_view_album(p_id, auth.uid()) then null else (
    select jsonb_build_object(
      'album', jsonb_build_object(
        'id', a.id, 'title', a.title, 'description', a.description, 'category', a.category,
        'visibility', a.visibility, 'published_at', a.published_at, 'created_at', a.created_at,
        'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
        'likes_count', a.likes_count, 'comments_count', a.comments_count, 'views_count', a.views_count,
        'cover_path', (select coalesce(m.storage_path) from media m where m.id = a.cover_media_id)),
      'author', jsonb_build_object('username', p.username, 'name', p.display_name, 'avatar', p.avatar_url),
      'is_author', a.author_id = auth.uid(),
      'can_edit', can_edit_album(a.id),
      'collaborators', coalesce((
        select jsonb_agg(jsonb_build_object('username', cp.username, 'name', cp.display_name, 'avatar', cp.avatar_url))
        from album_collaborators c join profiles cp on cp.id = c.user_id
        where c.album_id = a.id), '[]'::jsonb),
      'liked', exists (select 1 from likes l where l.subject_type='album' and l.subject_id=a.id and l.user_id=auth.uid()),
      'saved', exists (select 1 from saves s where s.album_id=a.id and s.user_id=auth.uid()),
      'chapters', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', c.id, 'label', c.label, 'title', c.title, 'body', c.body, 'position', c.position,
          'media', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', m.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
              'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
              'caption', am.caption, 'position', am.position, 'is_private', am.is_private) order by am.position)
            from album_media am join media m on m.id = am.media_id
            where am.chapter_id = c.id
              and (not am.is_private or can_edit_album(a.id))), '[]'::jsonb)
        ) order by c.position)
        from album_chapters c where c.album_id = a.id), '[]'::jsonb),
      'loose', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
          'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
          'caption', am.caption, 'position', am.position, 'is_private', am.is_private) order by am.position)
        from album_media am join media m on m.id = am.media_id
        where am.album_id = a.id and am.chapter_id is null
          and (not am.is_private or can_edit_album(a.id))), '[]'::jsonb)
    )
    from albums a join profiles p on p.id = a.author_id where a.id = p_id
  ) end;
$$;

-- Превью в лентах не должны брать приватные файлы.
create or replace function public.feed_albums(
  p_seed text default 'seed', p_category text default null,
  p_limit int default 24, p_offset int default 0)
returns table (
  id uuid, title text, category text, description text,
  author_username text, author_name text, author_avatar text,
  cover_path text, thumb1_path text, thumb1_kind media_kind,
  thumb2_path text, thumb2_kind media_kind,
  photos_count int, videos_count int, audio_count int,
  likes_count int, comments_count int, views_count int,
  published_at timestamptz)
language sql stable security definer set search_path = public as $$
  with vis as (
    select a.* from albums a
    where a.published_at is not null
      and can_view_album(a.id, auth.uid())
      and (p_category is null or a.category = p_category)
  )
  select v.id, v.title, v.category, v.description,
         p.username, p.display_name, p.avatar_url,
         coalesce(cm.thumb_path, cm.storage_path, t1.path),
         t1.path, t1.kind, t2.path, t2.kind,
         v.photos_count, v.videos_count, v.audio_count,
         v.likes_count, v.comments_count, v.views_count, v.published_at
  from vis v
  join profiles p on p.id = v.author_id
  left join media cm on cm.id = v.cover_media_id
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = v.id and m.kind <> 'audio' and not am.is_private
      and (v.cover_media_id is null or m.id <> v.cover_media_id)
    order by am.position limit 1 offset 0) t1 on true
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = v.id and m.kind <> 'audio' and not am.is_private
      and (v.cover_media_id is null or m.id <> v.cover_media_id)
    order by am.position limit 1 offset 1) t2 on true
  order by
    0.5 * ((('x0' || substr(md5(v.id::text || p_seed), 1, 7))::bit(32)::int)::double precision / 268435455.0)
  + 0.3 * least(1.0, ln(1 + v.likes_count * 3 + v.views_count)::double precision / ln(1000))
  + 0.2 * exp(- extract(epoch from (now() - v.published_at)) / (14 * 86400))
    desc
  limit greatest(1, least(p_limit, 60)) offset greatest(0, p_offset);
$$;

-- ============================================================ grants

grant select on album_collaborators to anon, authenticated;

revoke execute on all functions in schema public from public;

grant execute on function
  public.can_view_album(uuid,uuid), public.can_view_post(uuid,uuid),
  public.can_view_subject(subject_kind,uuid,uuid), public.can_view_media(uuid,uuid),
  public.can_view_storage_media(text), public.are_friends(uuid,uuid),
  public.owns_album(uuid), public.owns_subject(subject_kind,uuid),
  public.can_edit_album(uuid), public.is_album_owner(uuid),
  public.feed_albums(text,text,int,int), public.feed_posts(int,int),
  public.get_album(uuid), public.get_post(uuid), public.get_profile(text),
  public.log_album_view(uuid), public.search_all(text)
to anon, authenticated;

grant execute on function
  public.ensure_profile(), public.friend_request(text),
  public.friend_respond(text,boolean), public.friend_remove(text),
  public.my_friends(), public.my_shared_albums(),
  public.my_media(text,int,int),
  public.album_collaborator_add(uuid,text), public.album_collaborator_remove(uuid,text)
to authenticated;
