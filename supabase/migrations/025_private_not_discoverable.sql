-- =====================================================================
-- 025: приватный альбом не должен попадать в витрины.
--
-- Найдено на живых данных: у альбома с видимостью «Только мне» был приглашённый
-- участник (роль contributor, вошёл по ссылке-приглашению). Ветка 2 в
-- can_view_album даёт таким людям доступ всегда — это осознанное решение, иначе
-- гости событийного альбома не смогли бы им пользоваться. Но из-за этого доступа
-- приватный альбом протекал ещё и в ЛЕНТУ, ПОИСК и ТРЕНДЫ: все они пускают
-- всё, что проходит can_view_album.
--
-- Витрина и доступ — разные вещи. Приглашённый может открыть альбом по ссылке и
-- увидеть его в профиле автора, но подсовывать приватный альбом в ленту
-- рекомендаций нельзя никому. В поиске владелец своё по-прежнему находит:
-- это навигация по собственному контенту, а не витрина.
--
-- ВНИМАНИЕ ПРО ЯДРО: здесь целиком переопределяются feed_albums, search_all
-- (были в 015), feed_recommended и trending_albums (были в 017). С этого момента
-- ЕДИНСТВЕННЫЙ источник их полного тела — ЭТА миграция. can_view_album не
-- трогаем, её тело живёт в 022.
-- =====================================================================

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
    where a.published_at is not null and a.hidden_at is null
      and a.visibility <> 'private'          -- в ленту приватное не попадает никогда
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

create or replace function public.search_all(p_q text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'albums', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'title', a.title, 'category', a.category,
        'author_username', p.username, 'author_name', p.display_name,
        'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
        'views_count', a.views_count, 'published_at', a.published_at,
        'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id),
        'thumb1', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                   where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1),
        'thumb2', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                   where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1 offset 1)))
      from albums a join profiles p on p.id = a.author_id
      where a.published_at is not null and a.hidden_at is null
        -- приватное показываем в поиске только самому владельцу
        and (a.visibility <> 'private' or a.author_id = auth.uid())
        and can_view_album(a.id, auth.uid()) and a.title ilike '%' || p_q || '%'
      limit 24), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url, 'bio', p.bio))
      from profiles p
      where p.banned_at is null and p.deleted_at is null
        and not is_blocked_between(p.id, auth.uid())
        and (p.username ilike '%' || p_q || '%' or p.display_name ilike '%' || p_q || '%')
      limit 12), '[]'::jsonb));
$$;

create or replace function public.feed_recommended(
  p_seed text default 'seed', p_limit int default 24, p_offset int default 0)
returns table (
  id uuid, title text, category text, description text,
  author_username text, author_name text, author_avatar text,
  cover_path text, thumb1_path text, thumb1_kind media_kind,
  thumb2_path text, thumb2_kind media_kind,
  photos_count int, videos_count int, audio_count int,
  likes_count int, comments_count int, views_count int,
  published_at timestamptz)
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as uid),
  weights as (
    select category, weight from user_category_weights((select uid from me))
  ),
  vis as (
    select a.* from albums a
    where a.published_at is not null and a.hidden_at is null
      and a.visibility <> 'private'
      and can_view_album(a.id, (select uid from me))
  ),
  scored as (
    select v.*,
      ( 0.35 * ((('x0' || substr(md5(v.id::text || p_seed), 1, 7))::bit(32)::int)::double precision / 268435455.0)
      + 0.25 * least(1.0, ln(1 + v.likes_count * 3 + v.views_count)::double precision / ln(1000))
      + 0.15 * exp(- extract(epoch from (now() - v.published_at)) / (14 * 86400))
      + 0.15 * coalesce((select least(1.0, aq.score * 4) from author_quality aq where aq.author_id = v.author_id), 0)
      + 0.05 * case when v.published_at > now() - interval '3 days' then 1 else 0 end
      + 0.35 * coalesce((select w.weight from weights w where w.category = v.category), 0)
      ) as score
    from vis v
  )
  select s.id, s.title, s.category, s.description,
         p.username, p.display_name, p.avatar_url,
         coalesce(cm.thumb_path, cm.storage_path, t1.path),
         t1.path, t1.kind, t2.path, t2.kind,
         s.photos_count, s.videos_count, s.audio_count,
         s.likes_count, s.comments_count, s.views_count, s.published_at
  from scored s
  join profiles p on p.id = s.author_id
  left join media cm on cm.id = s.cover_media_id
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = s.id and m.kind <> 'audio' and not am.is_private
      and (s.cover_media_id is null or m.id <> s.cover_media_id)
    order by am.position limit 1 offset 0) t1 on true
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = s.id and m.kind <> 'audio' and not am.is_private
      and (s.cover_media_id is null or m.id <> s.cover_media_id)
    order by am.position limit 1 offset 1) t2 on true
  order by s.score desc
  limit greatest(1, least(p_limit, 60)) offset greatest(0, p_offset);
$$;

create or replace function public.trending_albums(p_period text default 'week', p_limit int default 24)
returns table (
  id uuid, title text, category text,
  author_username text, author_name text, author_avatar text,
  cover_path text, thumb1_path text, thumb1_kind media_kind,
  thumb2_path text, thumb2_kind media_kind,
  photos_count int, videos_count int, audio_count int,
  likes_count int, comments_count int, views_count int,
  published_at timestamptz, heat double precision)
language sql stable security definer set search_path = public as $$
  with win as (
    select case when p_period = 'month' then interval '30 days' else interval '7 days' end as w
  ),
  vis as (
    select a.* from albums a
    where a.published_at is not null and a.hidden_at is null
      and a.visibility <> 'private'
      and can_view_album(a.id, auth.uid())
  ),
  heat as (
    select v.id,
      ( coalesce((select count(*) from likes l where l.subject_type='album' and l.subject_id=v.id
                    and l.created_at > now() - (select w from win)), 0) * 3
      + coalesce((select count(*) from saves s where s.album_id=v.id
                    and s.created_at > now() - (select w from win)), 0) * 4
      + coalesce((select count(*) from comments c where c.subject_type='album' and c.subject_id=v.id
                    and c.created_at > now() - (select w from win) and c.hidden_at is null), 0) * 2
      + coalesce((select count(*) from album_views av where av.album_id=v.id
                    and av.day > (now() - (select w from win))::date), 0) * 1
      )::double precision as heat
    from vis v
  )
  select v.id, v.title, v.category, p.username, p.display_name, p.avatar_url,
         coalesce(cm.thumb_path, cm.storage_path, t1.path),
         t1.path, t1.kind, t2.path, t2.kind,
         v.photos_count, v.videos_count, v.audio_count,
         v.likes_count, v.comments_count, v.views_count, v.published_at, h.heat
  from vis v
  join heat h on h.id = v.id and h.heat > 0
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
  order by h.heat desc, v.published_at desc
  limit greatest(1, least(p_limit, 60));
$$;

-- ---------------------------------------------------------------- гранты
-- Supabase раздаёт execute новым телам сам, но полагаться на это нельзя.
grant execute on function
  public.feed_albums(text,text,int,int),
  public.search_all(text),
  public.feed_recommended(text,int,int),
  public.trending_albums(text,int)
to anon, authenticated;
