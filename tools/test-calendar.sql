-- Тест calendar_albums: календарь — личный, показывает только СВОИ альбомы.
-- Запуск: tools/sql.ps1 tools/test-calendar.sql
-- Всё в транзакции с откатом: на живых данных следов не остаётся.

begin;

do $test$
declare
  me    uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  a_mine   uuid;
  a_other  uuid;
  a_draft  uuid;
  res jsonb;
  n int;
begin
  perform set_config('request.jwt.claims', '', true);

  insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', me, 'authenticated', 'authenticated',
          me || '@test.local', false, now(), now()),
         ('00000000-0000-0000-0000-000000000000', other, 'authenticated', 'authenticated',
          other || '@test.local', false, now(), now());
  insert into public.profiles (id, username, display_name)
  values (me,    'tstcal_me_'    || left(me::text, 8),    'Me'),
         (other, 'tstcal_other_' || left(other::text, 8), 'Other');

  -- мой опубликованный альбом с датой
  insert into public.albums (author_id, title, visibility, published_at, date_from, moderation_status)
  values (me, 'Мой поход', 'public', now(), date '2026-05-01', 'approved')
  returning id into a_mine;

  -- чужой ПУБЛИЧНЫЙ альбом с датой: виден мне в ленте, но в моём календаре
  -- ему делать нечего
  insert into public.albums (author_id, title, visibility, published_at, date_from, moderation_status)
  values (other, 'Чужая свадьба', 'public', now(), date '2026-05-02', 'approved')
  returning id into a_other;

  -- мой черновик с датой: он мой, календарь личный — пусть будет виден
  insert into public.albums (author_id, title, visibility, date_from)
  values (me, 'Черновик с датой', 'private', date '2026-05-03')
  returning id into a_draft;

  -- ------------------------------------------------ смотрю своим календарём
  perform set_config('request.jwt.claims',
    json_build_object('sub', me, 'role', 'authenticated')::text, true);
  res := public.calendar_albums(null);

  select count(*) into n from jsonb_array_elements(res) e
   where (e ->> 'id')::uuid = a_mine;
  assert n = 1, 'своего альбома нет в календаре';

  select count(*) into n from jsonb_array_elements(res) e
   where (e ->> 'id')::uuid = a_other;
  assert n = 0, 'ЧУЖОЙ альбом попал в личный календарь';

  select count(*) into n from jsonb_array_elements(res) e
   where (e ->> 'id')::uuid = a_draft;
  assert n = 1, 'своего черновика с датой нет в календаре';

  select jsonb_array_length(res) into n;
  assert n = 2, 'в календаре должно быть ровно 2 моих альбома, а их ' || n;

  -- ------------------------------------------------ фильтр по году работает
  res := public.calendar_albums(2026);
  assert jsonb_array_length(res) = 2, 'фильтр по 2026 потерял альбомы';
  res := public.calendar_albums(2020);
  assert jsonb_array_length(res) = 0, 'фильтр по 2020 что-то вернул';

  -- ------------------------------------------------ аноним: пустой календарь
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claims',
    json_build_object('role', 'anon')::text, true);
  res := public.calendar_albums(null);
  assert jsonb_array_length(res) = 0,
    'анониму календарь должен быть пуст, а вернулось ' || jsonb_array_length(res);

  raise notice 'ТЕСТ ПРОЙДЕН: календарь показывает только свои альбомы';
end $test$;

rollback;
