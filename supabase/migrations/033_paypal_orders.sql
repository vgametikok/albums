-- 033_paypal_orders.sql — разовая оплата событийного альбома ($39.99) через PayPal.
--
-- В отличие от Pro (подписка), событие — разовый платёж (PayPal Orders API):
-- заказ → одобрение покупателем → capture. Результат — +1 кредит в event_quota
-- (той же, что раздаёт admin_grant_event из панели). Начисление идемпотентно по
-- order_id: и путь возврата (capture-order), и вебхук PAYMENT.CAPTURE.COMPLETED
-- зовут одну функцию, кредит не задваивается.

create table if not exists public.paypal_orders (
  order_id    text primary key,          -- id заказа PayPal
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null default 'event',
  status      text not null,
  created_at  timestamptz not null default now()
);
create index if not exists paypal_orders_user on public.paypal_orders(user_id);
alter table public.paypal_orders enable row level security;   -- только сервисный ключ

-- Идемпотентно: записать заказ и выдать 1 кредит события. Повтор с тем же
-- order_id — no-op (кредит не начисляется дважды). Только сервисный ключ.
create or replace function public.paypal_grant_event(p_order_id text, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into paypal_orders (order_id, user_id, kind, status)
    values (p_order_id, p_user_id, 'event', 'COMPLETED')
  on conflict (order_id) do nothing;
  if not found then return; end if;   -- заказ уже учтён — кредит не добавляем

  insert into event_quota (user_id, credits, granted_total)
    values (p_user_id, 1, 1)
  on conflict (user_id) do update
    set credits       = event_quota.credits + 1,
        granted_total = event_quota.granted_total + 1,
        updated_at    = now();
end $$;

revoke execute on function public.paypal_grant_event(text,uuid) from public, anon, authenticated;
