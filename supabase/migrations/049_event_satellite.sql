-- =====================================================================
-- 049: альбом-спутник события (спека internal/GUEST-LOOP-PLAN.md).
--
-- Обещание продукта: гость, загрузивший фото в событийный альбом и вошедший
-- по-настоящему, получает в СВОЁМ профиле собственный альбом с его кадрами
-- с этого события. Загрузка — не акт дарения, а акт сохранения.
--
-- Только новые объекты (правило из шапки PLAN.md): колонка, индекс, одна
-- definer-RPC. Ядро видимости не трогается: can_view_media уже считает OR
-- по всем альбомам файла, второй связи album_media этого достаточно.
--
-- Решения (утверждены владельцем 2026-08-27):
--  — спутник — ОБЫЧНЫЙ альбом: обложка, переименование, видимость, лента;
--  — создаётся приватным ЧЕРНОВИКОМ (published_at = null): владелец видит
--    его в профиле сразу, а очередь модерации (pending + published) не
--    забивается сотнями приватных спутников; публикация — обычный путь;
--  — если событие удалено, спутник выживает (on delete set null): фото
--    гостя не умирают вместе с чужим событием;
--  — пользователь удалил спутник — следующий sync создаст заново:
--    обещание «загруженное сохраняется у вас» важнее редкого края.
-- =====================================================================

alter table public.albums add column if not exists event_source_id uuid
  references public.albums(id) on delete set null;

-- Один спутник на пару (событие, человек). Индекс начинается с
-- event_source_id — он же обслуживает FK при удалении события.
create unique index if not exists albums_satellite_uniq
  on public.albums (event_source_id, author_id)
  where event_source_id is not null;

/**
 * Создаёт (при первом вызове) спутник события для вызывающего и доносит в
 * него все его файлы, уже лежащие в событии. Идемпотентна: повторный вызов
 * ничего не дублирует. Вызывается фронтом после guest_claim_finish и после
 * каждой успешной пачки загрузок вошедшего участника (js/join.js).
 *
 * Требования: настоящий (не анонимный) вход; p_event — событийный альбом;
 * вызывающий — не владелец события и при этом участник либо владелец
 * файлов в нём. Место в R2 не расходуется: album_media — вторая ссылка
 * на тот же media, резерв один.
 */
create or replace function public.event_satellite_sync(p_event uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  me_anon boolean;
  ev albums;
  sat_id uuid;
  linked int;
begin
  if me is null then raise exception 'auth required'; end if;
  select coalesce(u.is_anonymous, false) into me_anon from auth.users u where u.id = me;
  if coalesce(me_anon, true) then raise exception 'Сначала войдите в настоящий аккаунт'; end if;

  select * into ev from albums where id = p_event;
  if not found or not ev.is_event then raise exception 'Не событийный альбом'; end if;
  if ev.author_id = me then raise exception 'Владельцу события спутник не нужен'; end if;

  if not exists (select 1 from album_collaborators c
                 where c.album_id = p_event and c.user_id = me)
     and not exists (select 1 from album_media am join media m on m.id = am.media_id
                     where am.album_id = p_event and m.owner_id = me) then
    raise exception 'Только для участников события';
  end if;

  select id into sat_id from albums
   where event_source_id = p_event and author_id = me;

  if sat_id is null then
    insert into albums (author_id, title, category, visibility, event_source_id)
    values (me, ev.title, ev.category, 'private', p_event)
    returning id into sat_id;
  end if;

  -- Доносим недостающее. Позиции — плотный хвост существующих; anon = false:
  -- в собственном альбоме подпись и так его.
  insert into album_media (album_id, media_id, position, anon)
  select sat_id, am.media_id,
         coalesce((select max(x.position) from album_media x where x.album_id = sat_id), -1)
           + row_number() over (order by am.position),
         false
    from album_media am join media m on m.id = am.media_id
   where am.album_id = p_event and m.owner_id = me
     and not exists (select 1 from album_media x
                     where x.album_id = sat_id and x.media_id = am.media_id);
  get diagnostics linked = row_count;

  -- Обложка — первый по порядку файл; при создании альбом был пуст.
  update albums
     set cover_media_id = (select am.media_id from album_media am
                            where am.album_id = sat_id
                            order by am.position limit 1)
   where id = sat_id and cover_media_id is null;

  return jsonb_build_object('album_id', sat_id, 'linked', linked);
end $$;

-- ---------------------------------------------------------------- гранты

grant execute on function public.event_satellite_sync(uuid) to authenticated;
