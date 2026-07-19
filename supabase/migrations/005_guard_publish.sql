-- Публикация — тоже решение владельца: соавтор наполняет альбом, но не решает,
-- когда он станет виден друзьям или всем.
create or replace function public.trg_album_owner_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.author_id <> old.author_id
     or new.visibility is distinct from old.visibility
     or new.is_pinned is distinct from old.is_pinned
     or new.published_at is distinct from old.published_at then
    if not exists (select 1 from albums where id = old.id and author_id = auth.uid()) then
      raise exception 'Видимость, публикацию и закрепление меняет только владелец альбома';
    end if;
  end if;
  return new;
end $$;
