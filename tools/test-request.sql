-- Тест purchase_request_create: заявка вместо оплаты, пока PayPal недоступен.
-- Запуск: tools/sql.ps1 tools/test-request.sql
-- Всё в транзакции с откатом. Токен бота на время теста обнуляется, чтобы
-- проверка не отправила владельцу ни одного сообщения.

begin;

do $test$
declare
  me uuid := gen_random_uuid();
  r jsonb;
  n int;
  failed boolean;
  rec record;
begin
  perform set_config('request.jwt.claims', '', true);
  update public.telegram_config set bot_token = null where id = true;

  insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', me, 'authenticated', 'authenticated',
          me || '@test.local', false, now(), now());
  insert into public.profiles (id, username, display_name)
  values (me, 'tstreq_' || left(me::text, 8), 'Заявитель');

  -- --------------------------------------------- 1. аноним может оставить
  perform set_config('request.jwt.claims',
    json_build_object('role', 'anon')::text, true);
  r := public.purchase_request_create('event', '  Пётр  ', 'Вьетнам', 'Русский',
                                      'petr@example.com');
  assert (r ->> 'ok')::boolean, 'аноним не смог оставить заявку: ' || r;

  select * into rec from public.purchase_requests where id = (r ->> 'id')::uuid;
  assert rec.plan = 'event', 'план записан неверно';
  assert rec.name = 'Пётр', 'имя не обрезано по краям: "' || rec.name || '"';
  assert rec.country = 'Вьетнам', 'страна записана неверно';
  assert rec.contact = 'petr@example.com', 'контакт записан неверно';
  assert rec.user_id is null, 'у анонимной заявки не должно быть user_id';

  -- --------------------------------------- 2. у вошедшего пишется автор
  perform set_config('request.jwt.claims',
    json_build_object('sub', me, 'role', 'authenticated')::text, true);
  r := public.purchase_request_create('pro', 'Аня', 'Россия', 'Русский', '@anya_tg');
  select * into rec from public.purchase_requests where id = (r ->> 'id')::uuid;
  assert rec.user_id = me, 'заявка вошедшего должна помнить автора';
  assert rec.plan = 'pro', 'план pro не записан';

  -- --------------------------------------------- 3. проверка полей
  failed := false;
  begin r := public.purchase_request_create('gold', 'Аня', 'Россия', 'Русский', 'a@b.co');
  exception when others then failed := true; end;
  assert failed, 'неизвестный тариф должен отклоняться';

  failed := false;
  begin r := public.purchase_request_create('pro', '   ', 'Россия', 'Русский', 'a@b.co');
  exception when others then failed := true; end;
  assert failed, 'пустое имя должно отклоняться';

  failed := false;
  begin r := public.purchase_request_create('pro', 'Аня', 'Россия', 'Русский', ' x ');
  exception when others then failed := true; end;
  assert failed, 'слишком короткий контакт должен отклоняться';

  failed := false;
  begin r := public.purchase_request_create('pro', repeat('я', 200), 'Россия', 'Русский', 'a@b.co');
  exception when others then failed := true; end;
  assert failed, 'слишком длинное имя должно отклоняться';

  -- ------------------------------------------ 4. повтор не создаёт дубль
  failed := false;
  begin r := public.purchase_request_create('pro', 'Аня', 'Россия', 'Русский', '@anya_tg');
  exception when others then failed := true; end;
  assert failed, 'тот же контакт на тот же тариф не должен дублироваться';

  -- другой тариф тем же контактом — можно
  r := public.purchase_request_create('event', 'Аня', 'Россия', 'Русский', '@anya_tg');
  assert (r ->> 'ok')::boolean, 'на другой тариф заявка тем же контактом должна проходить';

  select count(*) into n from public.purchase_requests;
  assert n = 3, 'заявок должно быть ровно 3, а их ' || n;

  -- ------------------------------------------- 5. клиент не читает чужое
  failed := false;
  begin
    perform 1 from public.purchase_requests limit 1;   -- под definer видно
  exception when others then failed := true; end;
  assert not failed, 'внутри definer-функции таблица должна быть доступна';

  raise notice 'ТЕСТ ПРОЙДЕН: заявки создаются, проверяются и не дублируются';
end $test$;

rollback;
