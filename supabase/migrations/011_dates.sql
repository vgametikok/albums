-- 011: время у альбомов — дата съёмки файла, даты самого альбома, авто-главы.
--
-- Дату съёмки читает клиент из ОРИГИНАЛА до сжатия (js/exif.js): при перекодировании
-- в WebP весь EXIF стирается вместе с GPS. Координаты не сохраняются нигде и никогда —
-- сохраняем только момент времени.

alter table media add column if not exists captured_at   timestamptz;
alter table media add column if not exists captured_from text
  check (captured_from is null or captured_from in ('exif','file','manual'));
create index if not exists media_captured_idx on media(owner_id, captured_at);

-- Даты альбома: конкретный день, диапазон, месяц или год.
do $$ begin
  create type date_precision as enum ('day','range','month','year');
exception when duplicate_object then null; end $$;

alter table albums add column if not exists date_from      date;
alter table albums add column if not exists date_to        date;
alter table albums add column if not exists date_precision date_precision;
create index if not exists albums_date_idx on albums(date_from) where date_from is not null;

/** Подсказка дат по содержимому: минимальная и максимальная дата съёмки. */
create or replace function public.album_date_hint(p_album uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not can_view_album(p_album, auth.uid()) then null else (
    select jsonb_build_object(
      'min', min(m.captured_at)::date,
      'max', max(m.captured_at)::date,
      'with_date', count(m.captured_at),
      'total', count(*))
    from album_media am join media m on m.id = am.media_id
    where am.album_id = p_album and not am.is_private
  ) end;
$$;

/**
 * Предпросмотр авто-глав: группируем файлы по дате съёмки, новая группа —
 * когда разрыв больше p_gap_hours. Ничего не меняет, только показывает,
 * что получится, чтобы человек согласился до применения.
 */
create or replace function public.album_autochapter_preview(p_album uuid, p_gap_hours int default 10)
returns jsonb language plpgsql security definer set search_path = public as $$
declare res jsonb;
begin
  if not can_edit_album(p_album) then raise exception 'Недостаточно прав'; end if;
  with ordered as (
    select am.id, am.media_id, m.captured_at,
           lag(m.captured_at) over (order by m.captured_at, am.position) as prev
    from album_media am join media m on m.id = am.media_id
    where am.album_id = p_album and m.captured_at is not null
  ), marked as (
    select *, case when prev is null
                   or captured_at - prev > make_interval(hours => greatest(1, p_gap_hours))
              then 1 else 0 end as is_new
    from ordered
  ), grouped as (
    select *, sum(is_new) over (order by captured_at, id) as grp from marked
  )
  select jsonb_agg(x order by x->>'from') into res from (
    select jsonb_build_object(
      'group', grp,
      'from', min(captured_at)::date,
      'to', max(captured_at)::date,
      'count', count(*),
      'media_ids', jsonb_agg(id order by captured_at)) as x
    from grouped group by grp
  ) s;
  return coalesce(res, '[]'::jsonb);
end $$;

/** Применяет разбивку: создаёт главы и раскладывает по ним файлы. */
create or replace function public.album_autochapter_apply(p_album uuid, p_gap_hours int default 10)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g jsonb; groups jsonb; pos int := 0; ch uuid; created int := 0; total int := 0;
begin
  if not can_edit_album(p_album) then raise exception 'Недостаточно прав'; end if;
  groups := album_autochapter_preview(p_album, p_gap_hours);
  if jsonb_array_length(groups) = 0 then return jsonb_build_object('created', 0); end if;
  if jsonb_array_length(groups) > 100 then raise exception 'Слишком много групп, увеличьте интервал'; end if;

  for g in select * from jsonb_array_elements(groups) loop
    total := total + jsonb_array_length(g->'media_ids');
    if total > 2000 then raise exception 'Слишком много файлов за один раз'; end if;

    insert into album_chapters (album_id, position, label, title)
    values (p_album, pos,
            to_char((g->>'from')::date, 'DD.MM.YYYY'),
            case when (g->>'from') = (g->>'to') then null
                 else to_char((g->>'from')::date, 'DD.MM') || ' — ' || to_char((g->>'to')::date, 'DD.MM') end)
    returning id into ch;

    update album_media set chapter_id = ch
     where album_id = p_album
       and id in (select (jsonb_array_elements_text(g->'media_ids'))::uuid);

    pos := pos + 1; created := created + 1;
  end loop;
  return jsonb_build_object('created', created);
end $$;

/** Календарь: альбомы, разложенные по времени. Только видимые зрителю. */
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
    where can_view_album(a.id, auth.uid())
      and coalesce(a.date_from, a.published_at::date) is not null
      and (p_year is null or extract(year from coalesce(a.date_from, a.published_at::date)) = p_year)
  ), '[]'::jsonb);
$$;
