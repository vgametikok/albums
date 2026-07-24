-- 031_paypal.sql — автоматический приём оплаты Pro через PayPal (подписки).
--
-- Архитектура: edge-функция paypal-webhook (verify_jwt=false, как r2-sign)
-- работает под СЕРВИСНЫМ ключом и на вебхук от PayPal вызывает
-- paypal_apply_sub(). Смена profiles.plan разрешена только сервисному ключу
-- (триггер trg_profile_guard из 021) — этот путь ту же дверь и использует,
-- поэтому выдать себе Pro в обход оплаты по-прежнему нельзя.
--
-- Правило грантов (гоча 020): Supabase раздаёт execute новым функциям через
-- default privileges, поэтому служебной функции отзываем execute явно.

-- Подписки: одна строка на подписку PayPal (id вида I-XXXXXXXX).
create table if not exists public.paypal_subscriptions (
  subscription_id     text primary key,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  status              text not null,          -- APPROVAL_PENDING | ACTIVE | SUSPENDED | CANCELLED | EXPIRED
  current_period_end  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists paypal_subs_user on public.paypal_subscriptions(user_id);

alter table public.paypal_subscriptions enable row level security;
-- Владелец видит свою подписку (для показа статуса «Pro активен до …» в кабинете).
drop policy if exists paypal_subs_read on public.paypal_subscriptions;
create policy paypal_subs_read on public.paypal_subscriptions
  for select using (user_id = auth.uid());
grant select on public.paypal_subscriptions to authenticated;

-- Журнал вебхуков: идемпотентность (PayPal штатно шлёт повторы одного события)
-- + аудит. Политик нет — таблица доступна только сервисному ключу.
create table if not exists public.paypal_events (
  event_id    text primary key,
  event_type  text not null,
  received_at timestamptz not null default now()
);
alter table public.paypal_events enable row level security;

-- Применить состояние подписки. Вызывает только paypal-webhook (сервисный ключ).
--   ACTIVE                       → plan=pro, plan_until = конец оплаченного периода + сутки запаса
--                                  (вебхук о продлении может прийти чуть позже даты списания);
--   SUSPENDED / EXPIRED          → plan=free сразу (оплата сорвалась / срок вышел);
--   CANCELLED                    → profiles НЕ трогаем: по нашей Refund Policy Pro живёт до
--                                  конца оплаченного периода. Плановый спуск сделает expire_plans()
--                                  (см. ниже), когда plan_until пройдёт.
-- Возврат plan к 'free' по прошедшему plan_until нигде не был автоматизирован —
-- expire_plans() закрывает это разом и для подписок, и для ручных грантов из панели.
create or replace function public.paypal_apply_sub(
  p_subscription_id  text,
  p_user_id          uuid,
  p_status           text,
  p_period_end       timestamptz
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into paypal_subscriptions (subscription_id, user_id, status, current_period_end)
    values (p_subscription_id, p_user_id, p_status, p_period_end)
  on conflict (subscription_id) do update
    set status             = excluded.status,
        current_period_end = excluded.current_period_end,
        updated_at         = now();

  if p_status = 'ACTIVE' then
    update profiles
       set plan       = 'pro',
           plan_until = coalesce(p_period_end, now() + interval '32 days') + interval '1 day'
     where id = p_user_id;
  elsif p_status in ('SUSPENDED', 'EXPIRED') then
    update profiles set plan = 'free', plan_until = null where id = p_user_id;
  end if;
  -- CANCELLED — намеренно ничего с profiles: дослуживает оплаченный срок.
end $$;

-- Плановый спуск истёкших тарифов. Сервисная, вызывается расписанием.
create or replace function public.expire_plans()
returns void language sql security definer set search_path = public as $$
  update profiles set plan = 'free', plan_until = null
   where plan = 'pro' and plan_until is not null and plan_until < now();
$$;

-- Раз в час снимаем истёкший Pro. pg_cron есть не во всех проектах — если его
-- нет, миграция не падает, а спуск повесим иначе (заметка в проекте).
do $$ begin
  perform cron.schedule('expire-plans', '7 * * * *', $q$select public.expire_plans();$q$);
exception when others then
  raise notice 'pg_cron unavailable, expire_plans not scheduled: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------- гранты
revoke execute on function public.paypal_apply_sub(text,uuid,text,timestamptz) from public, anon, authenticated;
revoke execute on function public.expire_plans()                               from public, anon, authenticated;
