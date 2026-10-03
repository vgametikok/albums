-- =====================================================================
-- 057: настройки печатной таблички с QR события (редактор на event.html).
--
-- Одна JSON-колонка на альбоме: дизайн, ориентация, цвета, фото-баннер,
-- свои заголовок и подзаголовок. Пишет её владелец обычным update по
-- политике albums_upd; соавторам (их политика тоже пускает) менять табличку
-- не даёт триггер ниже. Пока миграции нет, сайт держит настройку в
-- localStorage устройства владельца — после применения начнёт писать сюда.
--
-- Идемпотентна: можно запускать повторно.
-- =====================================================================

alter table public.albums add column if not exists event_sign jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'albums_event_sign_chk') then
    alter table public.albums add constraint albums_event_sign_chk
      check (event_sign is null or (jsonb_typeof(event_sign) = 'object' and pg_column_size(event_sign) < 8192));
  end if;
end $$;

-- Табличку меняет только владелец альбома (или сервисный ключ).
create or replace function public.trg_album_event_sign_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.event_sign is distinct from old.event_sign
     and auth.uid() is not null and auth.uid() <> old.author_id then
    raise exception 'Only the album owner can change the QR sign';
  end if;
  return new;
end $$;

drop trigger if exists albums_event_sign_owner_t on public.albums;
create trigger albums_event_sign_owner_t before update on public.albums
  for each row execute function public.trg_album_event_sign_owner();
