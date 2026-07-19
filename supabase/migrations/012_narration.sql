-- 012: озвучка альбома — один голосовой рассказ на весь альбом и метки,
--      на какой секунде какое медиа показывать.
--
-- Аудио хранится обычной строкой media (тот же приватный бакет). Доступ к нему
-- вплетается в can_view_media один раз в 015: рассказ виден тем же, кому виден
-- альбом (см. PLAN.md).

create table if not exists album_narrations (
  album_id   uuid primary key references albums(id) on delete cascade,
  media_id   uuid not null references media(id) on delete cascade,
  duration   numeric(10,2),
  created_by uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists narration_cues (
  id             uuid primary key default gen_random_uuid(),
  album_id       uuid not null references albums(id) on delete cascade,
  album_media_id uuid not null references album_media(id) on delete cascade,
  at_seconds     numeric(10,2) not null check (at_seconds >= 0),
  unique (album_id, album_media_id)
);
create index if not exists narration_cues_idx on narration_cues(album_id, at_seconds);

alter table album_narrations enable row level security;
alter table narration_cues   enable row level security;

drop policy if exists narration_read on album_narrations;
drop policy if exists narration_all  on album_narrations;
create policy narration_read on album_narrations for select using (can_view_album(album_id, auth.uid()));
create policy narration_all  on album_narrations for all
  using (can_edit_album(album_id)) with check (can_edit_album(album_id));

drop policy if exists cues_read on narration_cues;
drop policy if exists cues_all  on narration_cues;
create policy cues_read on narration_cues for select using (can_view_album(album_id, auth.uid()));
create policy cues_all  on narration_cues for all
  using (can_edit_album(album_id)) with check (can_edit_album(album_id));

/** Медиа-строка озвучки альбома — нужна для can_view_media в 015. */
create or replace function public.is_narration_media(m_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from album_narrations where media_id = m_id);
$$;

/** Альбом, к которому относится аудио-рассказ (для проверки доступа). */
create or replace function public.narration_album_of(m_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select album_id from album_narrations where media_id = m_id limit 1;
$$;

create or replace function public.narration_set(p_album uuid, p_media uuid, p_duration numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not can_edit_album(p_album) then raise exception 'Недостаточно прав'; end if;
  if not exists (select 1 from media where id = p_media and owner_id = auth.uid()) then
    raise exception 'Можно использовать только свою запись';
  end if;
  insert into album_narrations (album_id, media_id, duration, created_by)
  values (p_album, p_media, p_duration, auth.uid())
  on conflict (album_id) do update
    set media_id = excluded.media_id, duration = excluded.duration, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.narration_clear(p_album uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not can_edit_album(p_album) then raise exception 'Недостаточно прав'; end if;
  delete from narration_cues   where album_id = p_album;
  delete from album_narrations where album_id = p_album;
  return jsonb_build_object('ok', true);
end $$;

/** Расстановка меток: [{album_media_id, at_seconds}, ...] целиком заменяет прежние. */
create or replace function public.narration_cues_set(p_album uuid, p_cues jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c jsonb; n int := 0;
begin
  if not can_edit_album(p_album) then raise exception 'Недостаточно прав'; end if;
  if jsonb_typeof(p_cues) <> 'array' then raise exception 'Ожидается массив меток'; end if;
  if jsonb_array_length(p_cues) > 500 then raise exception 'Слишком много меток'; end if;

  delete from narration_cues where album_id = p_album;
  for c in select * from jsonb_array_elements(p_cues) loop
    insert into narration_cues (album_id, album_media_id, at_seconds)
    select p_album, (c->>'album_media_id')::uuid, (c->>'at_seconds')::numeric
    where exists (select 1 from album_media am
                  where am.id = (c->>'album_media_id')::uuid and am.album_id = p_album)
    on conflict (album_id, album_media_id) do update set at_seconds = excluded.at_seconds;
    n := n + 1;
  end loop;
  return jsonb_build_object('count', n);
end $$;

/** Рассказ альбома для плеера: путь к аудио и метки. */
create or replace function public.narration_get(p_album uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not can_view_album(p_album, auth.uid()) then null else (
    select jsonb_build_object(
      'media_id', n.media_id,
      'path', m.storage_path,
      'duration', n.duration,
      'cues', coalesce((
        select jsonb_agg(jsonb_build_object('album_media_id', q.album_media_id, 'at', q.at_seconds)
                         order by q.at_seconds)
        from narration_cues q where q.album_id = p_album), '[]'::jsonb))
    from album_narrations n join media m on m.id = n.media_id
    where n.album_id = p_album
  ) end;
$$;

grant select on album_narrations, narration_cues to anon, authenticated;
