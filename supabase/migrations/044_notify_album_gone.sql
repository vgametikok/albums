-- =====================================================================
-- 044: уведомление в Telegram больше не оставляет призраков.
--
-- Было: сообщение «новый альбом на проверку» приходит в момент публикации и
-- живёт само по себе. Автор успевает передумать за минуту (реальный случай:
-- альбом опубликован в 23:53:10 и удалён в 23:53:58), а владелец идёт в
-- админку и видит пустую очередь — проверять уже нечего, но об этом никто не
-- сказал.
--
-- Стало: (1) в сообщении есть прямая ссылка на альбом в панели модерации;
-- (2) уход альбома из очереди — удаление или возврат в черновики — тоже
-- приходит отдельным сообщением.
--
-- Условия триггеров дословно повторяют фильтр mod_pending_albums
-- (published_at is not null and moderation_status = 'pending'): что попало в
-- очередь — о том и сообщаем, о черновиках не беспокоим.
-- =====================================================================

-- Адрес панели держим одной функцией: сменится домен — правка в одном месте.
create or replace function public.mod_album_link(p_album uuid)
returns text language sql immutable set search_path = public as $$
  select 'https://albums.ink/moderation.html?album=' || p_album::text;
$$;

-- ---------------------------------------------------------------- новый альбом

/** Тот же текст, что и в 024, плюс ссылка на альбом в панели модерации. */
create or replace function public.trg_notify_album_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare author text;
begin
  select username into author from profiles where id = new.author_id;
  perform notify_telegram(
    '🖼 Новый альбом на проверку' || chr(10) ||
    '«' || left(new.title, 120) || '» — @' || coalesce(author, '?') || chr(10) ||
    coalesce(new.category || ' · ', '') ||
    new.photos_count || 'ф ' || new.videos_count || 'в ' || new.audio_count || 'а' || chr(10) ||
    mod_album_link(new.id));
  return new;
exception when others then
  return new;   -- сборка текста не должна ронять публикацию альбома
end $$;

-- ---------------------------------------------------------------- альбом удалён

/**
 * Автор удалил альбом, пока тот ждал проверки. Файлы остаются в его медиатеке
 * (так обещает подтверждение при удалении), но самой строки albums больше нет —
 * очередь пуста на законных основаниях.
 *
 * Профиль пропал вместе с альбомом — значит это каскад от удаления аккаунта,
 * а не решение про конкретный альбом: молчим, чтобы удаление аккаунта с
 * десятком неодобренных альбомов не превратилось в десяток сообщений.
 */
create or replace function public.trg_notify_album_deleted()
returns trigger language plpgsql security definer set search_path = public as $$
declare author text;
begin
  select username into author from profiles where id = old.author_id;
  if author is null then return old; end if;
  perform notify_telegram(
    '🗑 Альбом с проверки удалён автором' || chr(10) ||
    '«' || left(old.title, 120) || '» — @' || author || chr(10) ||
    'Проверять нечего, очередь пуста не по ошибке.');
  return old;
exception when others then
  return old;   -- уведомление не должно мешать автору удалить своё
end $$;

drop trigger if exists trg_notify_album_deleted_t on public.albums;
create trigger trg_notify_album_deleted_t after delete on public.albums
  for each row
  when (old.published_at is not null and old.moderation_status = 'pending')
  execute function public.trg_notify_album_deleted();

-- ---------------------------------------------------------------- снят с публикации

/**
 * Кнопка «В черновики» в редакторе: альбом цел, но из очереди ушёл. Ссылку
 * оставляем — mod_open_album открывает альбом по id независимо от статуса,
 * так что посмотреть, что там было, всё ещё можно.
 */
create or replace function public.trg_notify_album_unpublished()
returns trigger language plpgsql security definer set search_path = public as $$
declare author text;
begin
  select username into author from profiles where id = new.author_id;
  perform notify_telegram(
    '↩️ Альбом снят с проверки — автор вернул его в черновики' || chr(10) ||
    '«' || left(new.title, 120) || '» — @' || coalesce(author, '?') || chr(10) ||
    mod_album_link(new.id));
  return new;
exception when others then
  return new;
end $$;

drop trigger if exists trg_notify_album_unpublished_t on public.albums;
create trigger trg_notify_album_unpublished_t after update on public.albums
  for each row
  when (old.published_at is not null and new.published_at is null
        and old.moderation_status = 'pending')
  execute function public.trg_notify_album_unpublished();

-- ---------------------------------------------------------------- гранты

revoke execute on function public.mod_album_link(uuid)                from public, anon, authenticated;
revoke execute on function public.trg_notify_album_review()           from public, anon, authenticated;
revoke execute on function public.trg_notify_album_deleted()          from public, anon, authenticated;
revoke execute on function public.trg_notify_album_unpublished()      from public, anon, authenticated;
