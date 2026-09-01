-- =====================================================================
-- 051: заявки на покупку вместо оплаты.
--
-- PayPal у владельца временно не работает, а продавать надо. Кнопки покупки
-- больше не уводят на оплату: человек оставляет заявку (имя, страна, язык
-- общения, контакт), она падает владельцу в тот же Telegram, что и остальные
-- уведомления, и он связывается сам. Цены на страницах остаются как были.
--
-- Заявку может оставить КТО УГОДНО, включая невошедшего: требовать аккаунт
-- ради «свяжитесь со мной» — терять клиента на ровном месте. Если человек
-- всё же вошёл, автора запоминаем.
--
-- Таблица без единой политики RLS: пишет только эта definer-функция, читает
-- владелец сервисным ключом (тот же приём, что у telegram_config и
-- mod_sessions).
-- =====================================================================

create table if not exists public.purchase_requests (
  id         uuid primary key default gen_random_uuid(),
  plan       text not null check (plan in ('pro', 'event')),
  name       text not null check (char_length(name) between 1 and 120),
  country    text not null check (char_length(country) between 1 and 80),
  lang       text not null check (char_length(lang) between 1 and 80),
  contact    text not null check (char_length(contact) between 3 and 200),
  user_id    uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
alter table public.purchase_requests enable row level security;
-- политик нет намеренно: клиенту таблица недоступна ни под одной ролью
revoke all on public.purchase_requests from anon, authenticated;

create index if not exists purchase_requests_new_idx
  on public.purchase_requests (created_at desc) where handled_at is null;

/**
 * Принять заявку и позвать владельца в Telegram.
 *
 * Возвращает {ok:true, id:…}. Отказы — обычные исключения с понятным текстом:
 * фронт показывает их человеку как есть.
 *
 * Защиты две, обе намеренно мягкие — это форма «свяжитесь со мной», а не
 * платёж:
 *   — тот же контакт на тот же тариф в течение часа второй раз не проходит
 *     (человек нажал дважды, а владелец получил бы две одинаковые заявки);
 *   — не больше 40 заявок в час на всех: анонима иначе нечем ограничить,
 *     а завалить Telegram владельца тысячей сообщений можно за минуту.
 */
create or replace function public.purchase_request_create(
  p_plan text, p_name text, p_country text, p_lang text, p_contact text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  v_name  text := btrim(coalesce(p_name, ''));
  v_geo   text := btrim(coalesce(p_country, ''));
  v_lang  text := btrim(coalesce(p_lang, ''));
  v_cont  text := btrim(coalesce(p_contact, ''));
  new_id  uuid;
  n       int;
begin
  if p_plan not in ('pro', 'event') then raise exception 'Неизвестный тариф'; end if;
  if char_length(v_name) < 1  or char_length(v_name) > 120 then raise exception 'Укажите имя'; end if;
  if char_length(v_geo)  < 1  or char_length(v_geo)  > 80  then raise exception 'Укажите страну'; end if;
  if char_length(v_lang) < 1  or char_length(v_lang) > 80  then raise exception 'Укажите язык'; end if;
  if char_length(v_cont) < 3  or char_length(v_cont) > 200 then raise exception 'Укажите контакт'; end if;

  if exists (select 1 from purchase_requests q
              where q.plan = p_plan and q.contact = v_cont
                and q.created_at > now() - interval '1 hour') then
    raise exception 'Заявка уже принята, мы свяжемся с вами';
  end if;

  select count(*) into n from purchase_requests
   where created_at > now() - interval '1 hour';
  if n >= 40 then raise exception 'Слишком много заявок, попробуйте позже'; end if;

  insert into purchase_requests (plan, name, country, lang, contact, user_id)
  values (p_plan, v_name, v_geo, v_lang, v_cont, me)
  returning id into new_id;

  perform notify_telegram(
    '💰 Заявка на ' || case p_plan when 'pro' then 'Pro ($9.99/мес)'
                                  else 'альбом события ($39.99)' end || chr(10) ||
    'Имя: '     || v_name || chr(10) ||
    'Страна: '  || v_geo  || chr(10) ||
    'Язык: '    || v_lang || chr(10) ||
    'Контакт: ' || v_cont ||
    coalesce(chr(10) || 'Аккаунт: @' || (select username from profiles where id = me), ''));

  return jsonb_build_object('ok', true, 'id', new_id);
end $$;

grant execute on function public.purchase_request_create(text, text, text, text, text)
  to anon, authenticated;
