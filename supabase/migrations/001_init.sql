-- Albums v1 — базовая схема, приватность, RLS, счётчики, RPC, Storage
-- Применяется на проекте rizveurkjpcwrmbtoawj

-- ============================================================ 1. ENUMS
do $$ begin
  create type media_kind as enum ('photo','video','audio');
exception when duplicate_object then null; end $$;

do $$ begin
  create type visibility_level as enum ('public','private','friends');
exception when duplicate_object then null; end $$;

do $$ begin
  create type friendship_status as enum ('pending','accepted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type subject_kind as enum ('album','post');
exception when duplicate_object then null; end $$;

-- ============================================================ 2. TABLES

create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name  text check (char_length(display_name) between 1 and 60),
  avatar_url    text,
  banner_url    text,
  bio           text check (char_length(bio) <= 300),
  location      text check (char_length(location) <= 80),
  created_at    timestamptz not null default now()
);

create table if not exists media (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references profiles(id) on delete cascade,
  kind             media_kind not null,
  storage_path     text not null,
  thumb_path       text,
  width            int,
  height           int,
  duration_seconds numeric(10,2),
  size_bytes       bigint,
  created_at       timestamptz not null default now()
);
create index if not exists media_owner_idx on media(owner_id, created_at desc);

create table if not exists albums (
  id             uuid primary key default gen_random_uuid(),
  author_id      uuid not null references profiles(id) on delete cascade,
  title          text not null check (char_length(title) between 1 and 120),
  description    text check (char_length(description) <= 2000),
  category       text check (category in ('Travel','Music','Family','Art','Sport','Other')),
  cover_media_id uuid references media(id) on delete set null,
  visibility     visibility_level not null default 'private',
  is_pinned      boolean not null default false,
  photos_count   int not null default 0,
  videos_count   int not null default 0,
  audio_count    int not null default 0,
  likes_count    int not null default 0,
  comments_count int not null default 0,
  views_count    int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  published_at   timestamptz
);
create index if not exists albums_author_idx on albums(author_id, published_at desc nulls last);
create index if not exists albums_feed_idx on albums(published_at desc) where published_at is not null;

create table if not exists album_chapters (
  id       uuid primary key default gen_random_uuid(),
  album_id uuid not null references albums(id) on delete cascade,
  position int not null default 0 check (position >= 0),
  label    text check (char_length(label) <= 40),
  title    text check (char_length(title) <= 120),
  body     text check (char_length(body) <= 4000)
);
create index if not exists album_chapters_album_idx on album_chapters(album_id, position);

create table if not exists album_media (
  id         uuid primary key default gen_random_uuid(),
  album_id   uuid not null references albums(id) on delete cascade,
  chapter_id uuid references album_chapters(id) on delete set null,
  media_id   uuid not null references media(id) on delete cascade,
  position   int not null default 0 check (position >= 0),
  caption    text check (char_length(caption) <= 500)
);
create index if not exists album_media_album_idx on album_media(album_id, position);
create index if not exists album_media_media_idx on album_media(media_id);

create table if not exists album_exceptions (
  album_id uuid not null references albums(id) on delete cascade,
  user_id  uuid not null references profiles(id) on delete cascade,
  primary key (album_id, user_id)
);

create table if not exists posts (
  id             uuid primary key default gen_random_uuid(),
  author_id      uuid not null references profiles(id) on delete cascade,
  caption        text check (char_length(caption) <= 2200),
  visibility     visibility_level not null default 'public',
  likes_count    int not null default 0,
  comments_count int not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists posts_author_idx on posts(author_id, created_at desc);
create index if not exists posts_feed_idx on posts(created_at desc);

create table if not exists post_media (
  post_id  uuid not null references posts(id) on delete cascade,
  position int not null check (position >= 0 and position < 10),
  media_id uuid not null references media(id) on delete cascade,
  primary key (post_id, position)
);
create index if not exists post_media_media_idx on post_media(media_id);

create table if not exists friendships (
  user_a       uuid not null references profiles(id) on delete cascade,
  user_b       uuid not null references profiles(id) on delete cascade,
  requested_by uuid not null references profiles(id) on delete cascade,
  status       friendship_status not null default 'pending',
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  primary key (user_a, user_b),
  check (user_a < user_b)
);
create index if not exists friendships_b_idx on friendships(user_b, status);

create table if not exists comments (
  id           uuid primary key default gen_random_uuid(),
  subject_type subject_kind not null,
  subject_id   uuid not null,
  author_id    uuid not null references profiles(id) on delete cascade,
  parent_id    uuid references comments(id) on delete cascade,
  body         text not null check (char_length(body) between 1 and 2000),
  created_at   timestamptz not null default now()
);
create index if not exists comments_subject_idx on comments(subject_type, subject_id, created_at);

create table if not exists likes (
  subject_type subject_kind not null,
  subject_id   uuid not null,
  user_id      uuid not null references profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (subject_type, subject_id, user_id)
);

create table if not exists saves (
  user_id    uuid not null references profiles(id) on delete cascade,
  album_id   uuid not null references albums(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, album_id)
);

create table if not exists album_views (
  album_id  uuid not null references albums(id) on delete cascade,
  viewer_id uuid not null references profiles(id) on delete cascade,
  day       date not null default current_date,
  primary key (album_id, viewer_id, day)
);

-- ============================================================ 3. ВИДИМОСТЬ (ядро приватности)

create or replace function public.are_friends(u1 uuid, u2 uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select u1 is not null and u2 is not null and exists (
    select 1 from friendships
    where user_a = least(u1,u2) and user_b = greatest(u1,u2) and status = 'accepted'
  );
$$;

create or replace function public.can_view_album(a_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from albums a
    where a.id = a_id and (
      a.author_id = viewer
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

create or replace function public.can_view_post(p_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from posts p
    where p.id = p_id and (
      p.author_id = viewer
      or p.visibility = 'public'
      or (p.visibility = 'friends' and are_friends(p.author_id, viewer))
    )
  );
$$;

create or replace function public.can_view_subject(st subject_kind, sid uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case st when 'album' then can_view_album(sid, viewer)
                 else can_view_post(sid, viewer) end;
$$;

create or replace function public.owns_album(a_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from albums where id = a_id and author_id = auth.uid());
$$;

create or replace function public.owns_subject(st subject_kind, sid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case st
    when 'album' then exists (select 1 from albums where id = sid and author_id = auth.uid())
    else exists (select 1 from posts where id = sid and author_id = auth.uid()) end;
$$;

create or replace function public.can_view_media(m_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from media where id = m_id and owner_id = viewer)
      or exists (select 1 from album_media am where am.media_id = m_id and can_view_album(am.album_id, viewer))
      or exists (select 1 from albums al where al.cover_media_id = m_id and can_view_album(al.id, viewer))
      or exists (select 1 from post_media pm where pm.media_id = m_id and can_view_post(pm.post_id, viewer));
$$;

-- путь в бакете media: <owner_uid>/<media_id>/orig.<ext> | thumb.jpg
create or replace function public.can_view_storage_media(obj_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare mid uuid;
begin
  begin
    mid := (string_to_array(obj_name, '/'))[2]::uuid;
  exception when others then
    return false;
  end;
  return can_view_media(mid, auth.uid());
end $$;

-- ============================================================ 4. RLS

alter table profiles         enable row level security;
alter table media            enable row level security;
alter table albums           enable row level security;
alter table album_chapters   enable row level security;
alter table album_media      enable row level security;
alter table album_exceptions enable row level security;
alter table posts            enable row level security;
alter table post_media       enable row level security;
alter table friendships      enable row level security;
alter table comments         enable row level security;
alter table likes            enable row level security;
alter table saves            enable row level security;
alter table album_views      enable row level security;

drop policy if exists profiles_read   on profiles;
drop policy if exists profiles_update on profiles;
create policy profiles_read   on profiles for select using (true);
create policy profiles_update on profiles for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists media_read on media;
drop policy if exists media_ins  on media;
drop policy if exists media_upd  on media;
drop policy if exists media_del  on media;
create policy media_read on media for select using (can_view_media(id, auth.uid()));
create policy media_ins  on media for insert with check (owner_id = auth.uid());
create policy media_upd  on media for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy media_del  on media for delete using (owner_id = auth.uid());

drop policy if exists albums_read on albums;
drop policy if exists albums_ins  on albums;
drop policy if exists albums_upd  on albums;
drop policy if exists albums_del  on albums;
create policy albums_read on albums for select using (can_view_album(id, auth.uid()));
create policy albums_ins  on albums for insert with check (author_id = auth.uid());
create policy albums_upd  on albums for update using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy albums_del  on albums for delete using (author_id = auth.uid());

drop policy if exists chapters_read on album_chapters;
drop policy if exists chapters_all  on album_chapters;
create policy chapters_read on album_chapters for select using (can_view_album(album_id, auth.uid()));
create policy chapters_all  on album_chapters for all  using (owns_album(album_id)) with check (owns_album(album_id));

drop policy if exists amedia_read on album_media;
drop policy if exists amedia_all  on album_media;
create policy amedia_read on album_media for select using (can_view_album(album_id, auth.uid()));
create policy amedia_all  on album_media for all  using (owns_album(album_id)) with check (owns_album(album_id));

drop policy if exists aexc_all on album_exceptions;
create policy aexc_all on album_exceptions for all using (owns_album(album_id)) with check (owns_album(album_id));

drop policy if exists posts_read on posts;
drop policy if exists posts_ins  on posts;
drop policy if exists posts_upd  on posts;
drop policy if exists posts_del  on posts;
create policy posts_read on posts for select using (can_view_post(id, auth.uid()));
create policy posts_ins  on posts for insert with check (author_id = auth.uid());
create policy posts_upd  on posts for update using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy posts_del  on posts for delete using (author_id = auth.uid());

drop policy if exists pmedia_read on post_media;
drop policy if exists pmedia_all  on post_media;
create policy pmedia_read on post_media for select using (can_view_post(post_id, auth.uid()));
create policy pmedia_all  on post_media for all
  using (exists (select 1 from posts where id = post_id and author_id = auth.uid()))
  with check (exists (select 1 from posts where id = post_id and author_id = auth.uid()));

-- дружба: читать может участник пары; запись — только через RPC
drop policy if exists friendships_read on friendships;
create policy friendships_read on friendships for select
  using (user_a = auth.uid() or user_b = auth.uid());

drop policy if exists comments_read on comments;
drop policy if exists comments_ins  on comments;
drop policy if exists comments_upd  on comments;
drop policy if exists comments_del  on comments;
create policy comments_read on comments for select using (can_view_subject(subject_type, subject_id, auth.uid()));
create policy comments_ins  on comments for insert
  with check (author_id = auth.uid() and can_view_subject(subject_type, subject_id, auth.uid()));
create policy comments_upd  on comments for update using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy comments_del  on comments for delete
  using (author_id = auth.uid() or owns_subject(subject_type, subject_id));

drop policy if exists likes_read on likes;
drop policy if exists likes_ins  on likes;
drop policy if exists likes_del  on likes;
create policy likes_read on likes for select using (user_id = auth.uid());
create policy likes_ins  on likes for insert
  with check (user_id = auth.uid() and can_view_subject(subject_type, subject_id, auth.uid()));
create policy likes_del  on likes for delete using (user_id = auth.uid());

drop policy if exists saves_read on saves;
drop policy if exists saves_ins  on saves;
drop policy if exists saves_del  on saves;
create policy saves_read on saves for select using (user_id = auth.uid());
create policy saves_ins  on saves for insert
  with check (user_id = auth.uid() and can_view_album(album_id, auth.uid()));
create policy saves_del  on saves for delete using (user_id = auth.uid());

-- album_views: только через RPC (политик нет = запрещено)

-- ============================================================ 5. ТРИГГЕРЫ-СЧЁТЧИКИ (definer!)

create or replace function public.trg_album_media_counts()
returns trigger language plpgsql security definer set search_path = public as $$
declare aid uuid;
begin
  aid := coalesce(new.album_id, old.album_id);
  update albums a set
    photos_count = (select count(*) from album_media am join media m on m.id=am.media_id where am.album_id=aid and m.kind='photo'),
    videos_count = (select count(*) from album_media am join media m on m.id=am.media_id where am.album_id=aid and m.kind='video'),
    audio_count  = (select count(*) from album_media am join media m on m.id=am.media_id where am.album_id=aid and m.kind='audio'),
    updated_at = now()
  where a.id = aid;
  return null;
end $$;

drop trigger if exists album_media_counts_t on album_media;
create trigger album_media_counts_t after insert or update or delete on album_media
for each row execute function public.trg_album_media_counts();

create or replace function public.trg_comment_counts()
returns trigger language plpgsql security definer set search_path = public as $$
declare st subject_kind; sid uuid; n int;
begin
  st := coalesce(new.subject_type, old.subject_type);
  sid := coalesce(new.subject_id, old.subject_id);
  select count(*) into n from comments where subject_type = st and subject_id = sid;
  if st = 'album' then update albums set comments_count = n where id = sid;
  else                 update posts  set comments_count = n where id = sid; end if;
  return null;
end $$;

drop trigger if exists comment_counts_t on comments;
create trigger comment_counts_t after insert or delete on comments
for each row execute function public.trg_comment_counts();

create or replace function public.trg_like_counts()
returns trigger language plpgsql security definer set search_path = public as $$
declare st subject_kind; sid uuid; n int;
begin
  st := coalesce(new.subject_type, old.subject_type);
  sid := coalesce(new.subject_id, old.subject_id);
  select count(*) into n from likes where subject_type = st and subject_id = sid;
  if st = 'album' then update albums set likes_count = n where id = sid;
  else                 update posts  set likes_count = n where id = sid; end if;
  return null;
end $$;

drop trigger if exists like_counts_t on likes;
create trigger like_counts_t after insert or delete on likes
for each row execute function public.trg_like_counts();

create or replace function public.trg_touch_updated()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists albums_touch_t on albums;
create trigger albums_touch_t before update on albums
for each row execute function public.trg_touch_updated();

-- ============================================================ 6. ПРОФИЛЬ ПРИ ВХОДЕ

create or replace function public.ensure_profile()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  em text; base text; cand text; n int := 0; nm text; av text;
  existing profiles;
begin
  if uid is null then raise exception 'auth required'; end if;
  select * into existing from profiles where id = uid;
  if found then
    return jsonb_build_object('id',existing.id,'username',existing.username,
      'display_name',existing.display_name,'avatar_url',existing.avatar_url,'created',false);
  end if;

  select email, raw_user_meta_data->>'full_name', raw_user_meta_data->>'avatar_url'
    into em, nm, av from auth.users where id = uid;

  base := lower(regexp_replace(coalesce(split_part(em,'@',1),'user'), '[^a-zA-Z0-9_]', '', 'g'));
  if base is null or char_length(base) < 3 then base := 'user'; end if;
  base := left(base, 20);
  cand := base;
  while exists (select 1 from profiles where username = cand) loop
    n := n + 1;
    cand := left(base, 20) || n::text;
  end loop;

  insert into profiles (id, username, display_name, avatar_url)
  values (uid, cand, coalesce(nullif(nm,''), cand), av);

  return jsonb_build_object('id',uid,'username',cand,'display_name',coalesce(nullif(nm,''),cand),
    'avatar_url',av,'created',true);
end $$;

-- ============================================================ 7. ЛЕНТЫ

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
    where am.album_id = v.id and m.kind <> 'audio'
      and (v.cover_media_id is null or m.id <> v.cover_media_id)
    order by am.position limit 1 offset 0) t1 on true
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = v.id and m.kind <> 'audio'
      and (v.cover_media_id is null or m.id <> v.cover_media_id)
    order by am.position limit 1 offset 1) t2 on true
  order by
    0.5 * ((('x0' || substr(md5(v.id::text || p_seed), 1, 7))::bit(32)::int)::double precision / 268435455.0)
  + 0.3 * least(1.0, ln(1 + v.likes_count * 3 + v.views_count)::double precision / ln(1000))
  + 0.2 * exp(- extract(epoch from (now() - v.published_at)) / (14 * 86400))
    desc
  limit greatest(1, least(p_limit, 60)) offset greatest(0, p_offset);
$$;

create or replace function public.feed_posts(
  p_limit int default 12, p_offset int default 0)
returns table (
  id uuid, caption text, created_at timestamptz,
  author_username text, author_name text, author_avatar text,
  likes_count int, comments_count int, liked boolean, slides jsonb)
language sql stable security definer set search_path = public as $$
  select p.id, p.caption, p.created_at,
         pr.username, pr.display_name, pr.avatar_url,
         p.likes_count, p.comments_count,
         exists (select 1 from likes l where l.subject_type='post' and l.subject_id=p.id and l.user_id=auth.uid()),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
             'width', m.width, 'height', m.height) order by pm.position)
           from post_media pm join media m on m.id = pm.media_id
           where pm.post_id = p.id), '[]'::jsonb)
  from posts p
  join profiles pr on pr.id = p.author_id
  where can_view_post(p.id, auth.uid())
  order by p.created_at desc
  limit greatest(1, least(p_limit, 40)) offset greatest(0, p_offset);
$$;

-- ============================================================ 8. СТРАНИЦЫ

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
      'liked', exists (select 1 from likes l where l.subject_type='album' and l.subject_id=a.id and l.user_id=auth.uid()),
      'saved', exists (select 1 from saves s where s.album_id=a.id and s.user_id=auth.uid()),
      'chapters', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', c.id, 'label', c.label, 'title', c.title, 'body', c.body,
          'media', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', m.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
              'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
              'caption', am.caption) order by am.position)
            from album_media am join media m on m.id = am.media_id
            where am.chapter_id = c.id), '[]'::jsonb)
        ) order by c.position)
        from album_chapters c where c.album_id = a.id), '[]'::jsonb),
      'loose', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
          'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
          'caption', am.caption) order by am.position)
        from album_media am join media m on m.id = am.media_id
        where am.album_id = a.id and am.chapter_id is null), '[]'::jsonb)
    )
    from albums a join profiles p on p.id = a.author_id where a.id = p_id
  ) end;
$$;

create or replace function public.get_post(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not can_view_post(p_id, auth.uid()) then null else (
    select jsonb_build_object(
      'id', p.id, 'caption', p.caption, 'created_at', p.created_at,
      'visibility', p.visibility,
      'likes_count', p.likes_count, 'comments_count', p.comments_count,
      'is_author', p.author_id = auth.uid(),
      'liked', exists (select 1 from likes l where l.subject_type='post' and l.subject_id=p.id and l.user_id=auth.uid()),
      'author', jsonb_build_object('username', pr.username, 'name', pr.display_name, 'avatar', pr.avatar_url),
      'slides', coalesce((
        select jsonb_agg(jsonb_build_object('kind', m.kind, 'path', m.storage_path,
          'thumb', m.thumb_path, 'width', m.width, 'height', m.height) order by pm.position)
        from post_media pm join media m on m.id = pm.media_id where pm.post_id = p.id), '[]'::jsonb))
    from posts p join profiles pr on pr.id = p.author_id where p.id = p_id
  ) end;
$$;

create or replace function public.get_profile(p_username text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'profile', jsonb_build_object(
      'id', p.id, 'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url,
      'banner', p.banner_url, 'bio', p.bio, 'location', p.location, 'created_at', p.created_at),
    'is_me', p.id = auth.uid(),
    'friend_state', case
      when p.id = auth.uid() then 'self'
      when auth.uid() is null then 'anon'
      else coalesce((
        select case when f.status = 'accepted' then 'friends'
                    when f.requested_by = auth.uid() then 'sent' else 'incoming' end
        from friendships f
        where f.user_a = least(p.id, auth.uid()) and f.user_b = greatest(p.id, auth.uid())), 'none')
      end,
    'friends_count', (select count(*) from friendships f
                      where f.status='accepted' and (f.user_a = p.id or f.user_b = p.id)),
    'albums_count', (select count(*) from albums a
                     where a.author_id = p.id and can_view_album(a.id, auth.uid())),
    'albums', coalesce((
      select jsonb_agg(x order by x->>'published_at' desc nulls first) from (
        select jsonb_build_object(
          'id', a.id, 'title', a.title, 'category', a.category, 'visibility', a.visibility,
          'is_pinned', a.is_pinned, 'published_at', a.published_at,
          'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
          'views_count', a.views_count, 'likes_count', a.likes_count,
          'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id),
          'thumb1', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                     where am.album_id=a.id and m.kind<>'audio' order by am.position limit 1 offset 0),
          'thumb2', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                     where am.album_id=a.id and m.kind<>'audio' order by am.position limit 1 offset 1)
        ) as x
        from albums a where a.author_id = p.id and can_view_album(a.id, auth.uid())
      ) s), '[]'::jsonb))
  from profiles p where p.username = lower(p_username);
$$;

create or replace function public.log_album_view(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); fresh boolean := true;
begin
  if not can_view_album(p_id, uid) then return; end if;
  if uid is not null then
    insert into album_views (album_id, viewer_id) values (p_id, uid)
    on conflict do nothing;
    get diagnostics fresh = row_count;
    if not fresh then return; end if;
  end if;
  update albums set views_count = views_count + 1 where id = p_id;
end $$;

create or replace function public.search_all(p_q text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'albums', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'title', a.title, 'category', a.category,
        'author_username', p.username, 'author_name', p.display_name,
        'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
        'views_count', a.views_count,
        'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id),
        'thumb1', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                   where am.album_id=a.id and m.kind<>'audio' order by am.position limit 1),
        'thumb2', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                   where am.album_id=a.id and m.kind<>'audio' order by am.position limit 1 offset 1)))
      from albums a join profiles p on p.id = a.author_id
      where a.published_at is not null and can_view_album(a.id, auth.uid())
        and a.title ilike '%' || p_q || '%'
      limit 24), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url, 'bio', p.bio))
      from profiles p
      where p.username ilike '%' || p_q || '%' or p.display_name ilike '%' || p_q || '%'
      limit 12), '[]'::jsonb));
$$;

-- ============================================================ 9. ДРУЖБА

create or replace function public.friend_request(p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); target uuid; f friendships;
begin
  if me is null then raise exception 'auth required'; end if;
  select id into target from profiles where username = lower(p_username);
  if target is null then raise exception 'user not found'; end if;
  if target = me then raise exception 'cannot friend yourself'; end if;

  select * into f from friendships
   where user_a = least(me,target) and user_b = greatest(me,target);

  if found then
    if f.status = 'accepted' then return jsonb_build_object('state','friends'); end if;
    if f.requested_by = me then return jsonb_build_object('state','sent'); end if;
    update friendships set status='accepted', responded_at=now()
     where user_a = least(me,target) and user_b = greatest(me,target);
    return jsonb_build_object('state','friends');
  end if;

  insert into friendships (user_a, user_b, requested_by)
  values (least(me,target), greatest(me,target), me);
  return jsonb_build_object('state','sent');
end $$;

create or replace function public.friend_respond(p_username text, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); other uuid; f friendships;
begin
  if me is null then raise exception 'auth required'; end if;
  select id into other from profiles where username = lower(p_username);
  if other is null then raise exception 'user not found'; end if;

  select * into f from friendships
   where user_a = least(me,other) and user_b = greatest(me,other) and status = 'pending';
  if not found then raise exception 'no pending request'; end if;
  if f.requested_by = me then raise exception 'cannot respond to your own request'; end if;

  if p_accept then
    update friendships set status='accepted', responded_at=now()
     where user_a = least(me,other) and user_b = greatest(me,other);
    return jsonb_build_object('state','friends');
  else
    delete from friendships
     where user_a = least(me,other) and user_b = greatest(me,other);
    return jsonb_build_object('state','none');
  end if;
end $$;

create or replace function public.friend_remove(p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); other uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select id into other from profiles where username = lower(p_username);
  if other is null then raise exception 'user not found'; end if;
  delete from friendships where user_a = least(me,other) and user_b = greatest(me,other);
  return jsonb_build_object('state','none');
end $$;

create or replace function public.my_friends()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'friends', coalesce((
      select jsonb_agg(jsonb_build_object('username',p.username,'name',p.display_name,'avatar',p.avatar_url))
      from friendships f
      join profiles p on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
      where f.status='accepted' and (f.user_a = auth.uid() or f.user_b = auth.uid())), '[]'::jsonb),
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object('username',p.username,'name',p.display_name,'avatar',p.avatar_url))
      from friendships f
      join profiles p on p.id = f.requested_by
      where f.status='pending' and f.requested_by <> auth.uid()
        and (f.user_a = auth.uid() or f.user_b = auth.uid())), '[]'::jsonb),
    'sent', coalesce((
      select jsonb_agg(jsonb_build_object('username',p.username,'name',p.display_name,'avatar',p.avatar_url))
      from friendships f
      join profiles p on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
      where f.status='pending' and f.requested_by = auth.uid()
        and (f.user_a = auth.uid() or f.user_b = auth.uid())), '[]'::jsonb));
$$;

-- ============================================================ 10. STORAGE

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars','avatars', true, 5242880,
        array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media','media', false, 52428800,
        array['image/jpeg','image/png','image/webp','image/gif',
              'video/mp4','video/webm','video/quicktime',
              'audio/webm','audio/mpeg','audio/mp4','audio/ogg','audio/wav'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_read  on storage.objects;
drop policy if exists avatars_write on storage.objects;
drop policy if exists media_read_p  on storage.objects;
drop policy if exists media_write   on storage.objects;
drop policy if exists media_update  on storage.objects;
drop policy if exists media_delete  on storage.objects;

create policy avatars_read on storage.objects for select
  using (bucket_id = 'avatars');
create policy avatars_write on storage.objects for insert
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy media_read_p on storage.objects for select
  using (bucket_id = 'media' and can_view_storage_media(name));
create policy media_write on storage.objects for insert
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy media_update on storage.objects for update
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy media_delete on storage.objects for delete
  using (bucket_id in ('media','avatars') and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================ 11. GRANTS

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;

revoke execute on all functions in schema public from public;

grant execute on function
  public.can_view_album(uuid,uuid), public.can_view_post(uuid,uuid),
  public.can_view_subject(subject_kind,uuid,uuid), public.can_view_media(uuid,uuid),
  public.can_view_storage_media(text), public.are_friends(uuid,uuid),
  public.owns_album(uuid), public.owns_subject(subject_kind,uuid),
  public.feed_albums(text,text,int,int), public.feed_posts(int,int),
  public.get_album(uuid), public.get_post(uuid), public.get_profile(text),
  public.log_album_view(uuid), public.search_all(text)
to anon, authenticated;

grant execute on function
  public.ensure_profile(), public.friend_request(text),
  public.friend_respond(text,boolean), public.friend_remove(text),
  public.my_friends()
to authenticated;
