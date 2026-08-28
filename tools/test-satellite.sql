-- Тест event_satellite_sync (спека internal/GUEST-LOOP-PLAN.md).
-- Запуск: tools/sql.ps1 tools/test-satellite.sql
-- Всё внутри транзакции с откатом: на живых данных не остаётся следов.
-- Падение любого assert — это провал теста; молчаливый OK в конце — успех.

begin;

do $test$
declare
  u_owner uuid := gen_random_uuid();   -- владелец события
  u_guest uuid := gen_random_uuid();   -- гость с настоящим аккаунтом
  u_anon  uuid := gen_random_uuid();   -- анонимная (гостевая) сессия
  u_other uuid := gen_random_uuid();   -- посторонний: не участник
  ev      uuid;                        -- событийный альбом
  m1 uuid := gen_random_uuid();        -- файлы гостя в событии
  m2 uuid := gen_random_uuid();
  sat uuid;                            -- альбом-спутник
  r jsonb;
  n int;
  failed boolean;
begin
  -- ------------------------------------------------------------ фикстуры
  -- Пишем как сервис: триггеры-стражи пропускают только service_role/пусто.
  perform set_config('request.jwt.claims', '', true);

  insert into auth.users (instance_id, id, aud, role, email, is_anonymous,
                          created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', u_owner, 'authenticated',
          'authenticated', u_owner || '@test.local', false, now(), now()),
         ('00000000-0000-0000-0000-000000000000', u_guest, 'authenticated',
          'authenticated', u_guest || '@test.local', false, now(), now()),
         ('00000000-0000-0000-0000-000000000000', u_anon, 'authenticated',
          'authenticated', null, true, now(), now()),
         ('00000000-0000-0000-0000-000000000000', u_other, 'authenticated',
          'authenticated', u_other || '@test.local', false, now(), now());

  insert into public.profiles (id, username, display_name)
  values (u_owner, 'tst_owner_' || left(u_owner::text, 8), 'Owner'),
         (u_guest, 'tst_guest_' || left(u_guest::text, 8), 'Guest'),
         (u_anon,  'tst_anon_'  || left(u_anon::text, 8),  'Anon'),
         (u_other, 'tst_other_' || left(u_other::text, 8), 'Other');

  -- Событие: приватный событийный альбом с двумя файлами гостя.
  insert into public.albums (author_id, title, category, visibility, published_at)
  values (u_owner, 'Свадьба-тест', 'Family', 'private', now())
  returning id into ev;
  update public.albums set is_event = true, moderation_status = 'approved'
   where id = ev;

  insert into public.media (id, owner_id, kind, storage_path)
  values (m1, u_guest, 'photo', 'r2/' || u_guest || '/' || m1 || '/orig.jpg'),
         (m2, u_guest, 'photo', 'r2/' || u_guest || '/' || m2 || '/orig.jpg');
  insert into public.album_media (album_id, media_id, position, anon)
  values (ev, m1, 0, true), (ev, m2, 1, true);
  insert into public.album_collaborators (album_id, user_id, added_by, role)
  values (ev, u_guest, u_owner, 'contributor');

  -- ------------------------------------------------------- 1. создание
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_guest, 'role', 'authenticated')::text, true);

  r := public.event_satellite_sync(ev);
  sat := (r ->> 'album_id')::uuid;
  assert sat is not null, 'sync не вернул album_id';
  assert (r ->> 'linked')::int = 2, 'sync должен слинковать оба файла, вернул: ' || r;

  select count(*) into n from public.albums
   where id = sat and author_id = u_guest and event_source_id = ev
     and visibility = 'private' and published_at is null
     and title = 'Свадьба-тест' and category = 'Family';
  assert n = 1, 'спутник не создан или создан не так';

  select count(*) into n from public.album_media
   where album_id = sat and media_id in (m1, m2);
  assert n = 2, 'в спутнике не оба файла';

  select photos_count into n from public.albums where id = sat;
  assert n = 2, 'триггер счётчиков не отработал: photos_count = ' || n;

  select count(*) into n from public.albums a
   join public.media m on m.id = a.cover_media_id
   where a.id = sat and a.cover_media_id = m1;
  assert n = 1, 'обложка спутника — не первый файл';

  -- ------------------------------------------------- 2. идемпотентность
  r := public.event_satellite_sync(ev);
  assert (r ->> 'album_id')::uuid = sat, 'повторный sync создал другой альбом';
  assert (r ->> 'linked')::int = 0, 'повторный sync что-то дослинковал';
  select count(*) into n from public.albums
   where event_source_id = ev and author_id = u_guest;
  assert n = 1, 'спутник задублировался';

  -- Новый файл в событии → следующий sync доносит только его.
  perform set_config('request.jwt.claims', '', true);
  declare m3 uuid := gen_random_uuid();
  begin
    insert into public.media (id, owner_id, kind, storage_path)
    values (m3, u_guest, 'photo', 'r2/' || u_guest || '/' || m3 || '/orig.jpg');
    insert into public.album_media (album_id, media_id, position, anon)
    values (ev, m3, 2, true);
  end;
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_guest, 'role', 'authenticated')::text, true);
  r := public.event_satellite_sync(ev);
  assert (r ->> 'linked')::int = 1, 'дозагрузка: должен долинковаться ровно один';

  -- ------------------------------------------------------ 3. запреты
  -- Владельцу события спутник не положен.
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  failed := false;
  begin
    r := public.event_satellite_sync(ev);
  exception when others then failed := true;
  end;
  assert failed, 'владелец события не должен получать спутник';

  -- Анонимная сессия — сначала войди по-настоящему.
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_anon, 'role', 'authenticated')::text, true);
  failed := false;
  begin
    r := public.event_satellite_sync(ev);
  exception when others then failed := true;
  end;
  assert failed, 'анонимная сессия не должна создавать спутник';

  -- Посторонний (не участник, файлов нет) — нет.
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_other, 'role', 'authenticated')::text, true);
  failed := false;
  begin
    r := public.event_satellite_sync(ev);
  exception when others then failed := true;
  end;
  assert failed, 'посторонний не должен создавать спутник';

  -- Не-событие — нет.
  perform set_config('request.jwt.claims', '', true);
  declare plain uuid;
  begin
    insert into public.albums (author_id, title, visibility)
    values (u_owner, 'Обычный альбом', 'private') returning id into plain;
    insert into public.album_collaborators (album_id, user_id, added_by, role)
    values (plain, u_guest, u_owner, 'contributor');
    perform set_config('request.jwt.claims',
      json_build_object('sub', u_guest, 'role', 'authenticated')::text, true);
    failed := false;
    begin
      r := public.event_satellite_sync(plain);
    exception when others then failed := true;
    end;
    assert failed, 'sync должен работать только на событийных альбомах';
  end;

  -- --------------------------------- 4. видимость: OR по двум альбомам
  -- Файл в приватном событии + публичном одобренном спутнике виден
  -- постороннему; приватное событие при этом не раскрывается.
  -- Видимость меняет владелец спутника (сторож trg_album_owner_fields),
  -- одобрение ставит сервис (сторож trg_album_review_guard).
  perform set_config('request.jwt.claims',
    json_build_object('sub', u_guest, 'role', 'authenticated')::text, true);
  update public.albums set visibility = 'public', published_at = now()
   where id = sat;
  perform set_config('request.jwt.claims', '', true);
  update public.albums set moderation_status = 'approved' where id = sat;
  assert public.can_view_media(m1, u_other), 'файл публичного спутника не виден постороннему';
  assert not public.can_view_album(ev, u_other), 'приватное событие раскрылось';

  -- --------------- 4б. чужой файл нельзя переложить в другой альбом
  -- Инвариант безопасности из 035 (trg_album_media_guard): владелец события
  -- НЕ может републиковать файл гостя в другом своём альбоме — атрибуция
  -- гостя живёт внутри события (подпись by) и в его спутнике. Тест
  -- фиксирует запрет, чтобы его не сняли молча.
  perform set_config('request.jwt.claims', '', true);
  declare showcase uuid;
  begin
    insert into public.albums (author_id, title, visibility)
    values (u_owner, 'Витрина', 'public') returning id into showcase;
    perform set_config('request.jwt.claims',
      json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
    failed := false;
    begin
      insert into public.album_media (album_id, media_id, position)
      values (showcase, m1, 0);
    exception when others then failed := true;
    end;
    assert failed, 'чужой файл лёг в другой альбом — сломан инвариант 035';
  end;

  -- ------------------------------- 5. событие удалено — спутник живёт
  delete from public.albums where id = ev;
  select count(*) into n from public.albums
   where id = sat and event_source_id is null;
  assert n = 1, 'после удаления события спутник должен выжить с event_source_id = null';

  raise notice 'ТЕСТ ПРОЙДЕН: все проверки event_satellite_sync зелёные';
end $test$;

rollback;
