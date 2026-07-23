-- =====================================================================
-- 028: «Только мне» означает буквально только автора.
--
-- Было: ветка 2 в can_view_album давала доступ соавторам и гостям события ВСЕГДА,
-- при любой видимости. Из-за этого альбом с настройкой «Только мне» видел
-- приглашённый участник — по прямой ссылке и в профиле автора. Решение владельца:
-- приватный альбом виден исключительно автору, и никак иначе.
--
-- Событийный альбом — это ДРУГОЙ тип приватности, а не точка на той же шкале.
-- Доступ к нему есть у каждого, кто вошёл по ссылке-приглашению, и видимость
-- «Только мне» на нём читается как «только для приглашённых»: участники видят,
-- посторонние нет, в ленту и поиск он не попадает (это уже сделано в 025).
--
-- Отсюда правило ветки 2: участник видит альбом, если альбом событийный
-- ЛИБО его видимость не «Только мне».
--
-- Следствие, принятое сознательно: соавтор обычного альбома с видимостью
-- «Только мне» доступ теряет. Если нужен помощник — у альбома не может быть
-- настройки «только мне», это противоречие в самой формулировке.
--
-- ВНИМАНИЕ ПРО ЯДРО: полное тело can_view_album теперь здесь (было в 022).
-- =====================================================================

create or replace function public.can_view_album(a_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from albums a
    where a.id = a_id and (
      -- 1. владелец: всегда и без каких-либо условий
      a.author_id = viewer
      -- 2. соавтор или гость события — но НЕ в альбоме «Только мне».
      --    Событийный альбом исключение: там «Только мне» = «только приглашённым».
      or (viewer is not null
          and (a.is_event or a.visibility <> 'private')
          and exists (select 1 from album_collaborators c
                      where c.album_id = a.id and c.user_id = viewer)
          and not is_blocked_between(a.author_id, viewer))
      -- 3. обычный зритель
      or (a.published_at is not null
          and a.hidden_at is null
          and a.moderation_status = 'approved'
          and not is_banned(a.author_id)
          and not exists (select 1 from profiles p where p.id = a.author_id and p.deleted_at is not null)
          and not is_blocked_between(a.author_id, viewer)
          and (a.visibility = 'public'
               or (a.visibility = 'friends'
                   and are_friends(a.author_id, viewer)
                   and not exists (select 1 from album_exceptions e
                                   where e.album_id = a.id and e.user_id = viewer))))
    ));
$$;

grant execute on function public.can_view_album(uuid,uuid) to anon, authenticated;
