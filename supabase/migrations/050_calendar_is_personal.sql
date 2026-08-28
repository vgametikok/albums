-- =====================================================================
-- 050: календарь становится личным — только СВОИ альбомы.
--
-- Было: calendar_albums отдавала всё, что видно зрителю (свои + друзей +
-- публичные). На общем экране это выглядело как вторая лента, только хуже:
-- чужие альбомы вперемешку с моими и без единого смысла у оси времени.
--
-- Стало: календарь живёт в личном кабинете и отвечает на один вопрос —
-- «что я публиковал и когда». Отсюда фильтр по author_id.
--
-- can_view_album из условия убран намеренно: для СВОИХ альбомов она всегда
-- истинна (первая ветка — «владелец: всегда и без каких-либо условий»),
-- так что проверка была бы лишней работой на каждой строке.
--
-- Анониму функция теперь отдаёт пустой массив: auth.uid() = null не совпадёт
-- ни с одним author_id. Это и нужно — календарь исчез из шапки для тех,
-- кто не вошёл.
--
-- Источник полного тела calendar_albums с этого момента — ЭТА миграция,
-- а не 011 (правило из шапки PLAN.md: правим целиком и в одном месте).
-- =====================================================================

create or replace function public.calendar_albums(p_year int default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'title', a.title, 'category', a.category,
      'date_from', a.date_from, 'date_to', a.date_to, 'precision', a.date_precision,
      'published_at', a.published_at,
      'author_username', p.username, 'author_name', p.display_name,
      'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
      'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id)
    ) order by coalesce(a.date_from, a.published_at::date) desc)
    from albums a join profiles p on p.id = a.author_id
    where a.author_id = auth.uid()
      and coalesce(a.date_from, a.published_at::date) is not null
      and (p_year is null or extract(year from coalesce(a.date_from, a.published_at::date)) = p_year)
  ), '[]'::jsonb);
$$;
