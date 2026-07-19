-- 017: рекомендации и «В тренде».
--
-- Требования: любимой категории до 70% ленты; у кого выше вовлечённость на
-- просмотр — того чаще показывают; у нового альбома небольшой стартовый приоритет;
-- вкладка «В тренде» — самое активное за неделю и месяц. Всё на голом Postgres.
--
-- Сигналы уже есть частично: album_views (просмотры), likes, saves, comments.
-- Отдельного dwell не вводим — на нашем масштабе хватает событий, которые уже
-- пишутся. Ядро видимости не трогаем (оно в 015); эта миграция только читает.

-- ---------------------------------------------------------------- вкус пользователя

/**
 * Интерес пользователя к категориям: по его лайкам, сейвам и просмотрам за
 * последние 90 дней. Возвращает нормированные веса (сумма = 1) или пусто.
 */
create or replace function public.user_category_weights(p_user uuid)
returns table (category text, weight double precision)
language sql stable security definer set search_path = public as $$
  with sig as (
    -- лайк весит 3, сейв 4, просмотр 1
    select a.category, 3.0 as w from likes l
      join albums a on a.id = l.subject_id
      where l.subject_type='album' and l.user_id = p_user and a.category is not null
        and l.created_at > now() - interval '90 days'
    union all
    select a.category, 4.0 from saves s
      join albums a on a.id = s.album_id
      where s.user_id = p_user and a.category is not null
        and s.created_at > now() - interval '90 days'
    union all
    select a.category, 1.0 from album_views v
      join albums a on a.id = v.album_id
      where v.viewer_id = p_user and a.category is not null
        and v.day > (now() - interval '90 days')::date
  ), agg as (
    select category, sum(w) as s from sig group by category
  )
  select category, s / nullif(sum(s) over (), 0) from agg;
$$;

-- ---------------------------------------------------------------- качество автора

/**
 * Качество автора = вовлечённость на просмотр. Лайки+сейвы+комментарии, делённые
 * на просмотры, со сглаживанием (чтобы автор с одним просмотром и одним лайком не
 * улетел в топ). Значение в диапазоне ~0..1, обновляется представлением на лету.
 */
create or replace view public.author_quality as
  select a.author_id,
         (sum(a.likes_count) + sum(a.comments_count) * 1.5)::double precision
           / (sum(a.views_count) + 20)  as score,   -- +20 сглаживание
         sum(a.views_count) as views
  from albums a
  where a.published_at is not null and a.hidden_at is null
  group by a.author_id;

-- ---------------------------------------------------------------- персональная лента

/**
 * Персональная лента. Логика:
 *  - базовый скор альбома = вовлечённость + свежесть + сид-случайность (как feed_albums);
 *  - множитель за качество автора;
 *  - НЕБОЛЬШОЙ буст новизне альбома (первые 3 дня);
 *  - квота: до 70% выдачи — из любимых категорий пользователя. Реализуем через
 *    добавку к скору за совпадение категории, взвешенную по силе интереса.
 * Для анонима и нового пользователя (нет сигналов) вырождается в обычный feed_albums.
 */
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
      and can_view_album(a.id, (select uid from me))
  ),
  scored as (
    select v.*,
      -- база: случайность + популярность + свежесть
      ( 0.35 * ((('x0' || substr(md5(v.id::text || p_seed), 1, 7))::bit(32)::int)::double precision / 268435455.0)
      + 0.25 * least(1.0, ln(1 + v.likes_count * 3 + v.views_count)::double precision / ln(1000))
      + 0.15 * exp(- extract(epoch from (now() - v.published_at)) / (14 * 86400))
      -- качество автора
      + 0.15 * coalesce((select least(1.0, aq.score * 4) from author_quality aq where aq.author_id = v.author_id), 0)
      -- стартовый буст новизне (первые 3 дня)
      + 0.05 * case when v.published_at > now() - interval '3 days' then 1 else 0 end
      -- интерес к категории: до 0.35 сверху — это и даёт «до 70% любимого»
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

-- ---------------------------------------------------------------- «В тренде»

/**
 * Тренды: альбомы с наибольшей активностью за окно (неделя/месяц). Активность —
 * лайки+сейвы+комментарии+просмотры за окно, а не за всё время, поэтому старый
 * популярный альбом не забивает свежую волну.
 */
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

grant execute on function
  public.feed_recommended(text,int,int),
  public.trending_albums(text,int),
  public.user_category_weights(uuid)
to anon, authenticated;
