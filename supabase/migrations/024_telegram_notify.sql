-- =====================================================================
-- 024: уведомления владельцу в Telegram.
--
-- Три события: новая регистрация, новый альбом ушёл на модерацию, новая
-- жалоба. Отправка — прямо из триггера базы через pg_net (уже включён),
-- без edge-функции: pg_net кладёт запрос в очередь и не блокирует
-- транзакцию, поэтому даже если Telegram недоступен, ни регистрация,
-- ни публикация альбома, ни жалоба не пострадают.
--
-- Токен бота и chat_id лежат в отдельной таблице без единой RLS-политики —
-- читает её только SECURITY DEFINER функция notify_telegram, клиенту
-- доступа нет ни под одной ролью (тот же приём, что у mod_sessions).
-- =====================================================================

create table if not exists public.telegram_config (
  id         boolean primary key default true check (id),
  bot_token  text,
  chat_id    text,
  updated_at timestamptz not null default now()
);
alter table public.telegram_config enable row level security;
insert into public.telegram_config (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------- отправка

/**
 * Шлёт текст владельцу в Telegram. Если бот ещё не настроен (нет токена или
 * chat_id) — молча выходит, ничего не ломает. Ошибки самого запроса тоже
 * гасятся: уведомление не должно уронить регистрацию, публикацию или жалобу.
 */
create or replace function public.notify_telegram(p_text text)
returns void language plpgsql security definer set search_path = public as $$
declare cfg record;
begin
  select bot_token, chat_id into cfg from telegram_config where id = true;
  if cfg.bot_token is null or cfg.chat_id is null then return; end if;

  perform net.http_post(
    url := 'https://api.telegram.org/bot' || cfg.bot_token || '/sendMessage',
    body := jsonb_build_object(
      'chat_id', cfg.chat_id,
      'text', left(p_text, 3900),
      'disable_web_page_preview', true),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 5000);
exception when others then null;
end $$;

-- ---------------------------------------------------------------- события

/** Новая регистрация. profiles.insert случается ровно один раз на человека —
    ensure_profile() сначала проверяет, есть ли строка, и создаёт только если нет. */
create or replace function public.trg_notify_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform notify_telegram(
    '🆕 Новая регистрация' || chr(10) ||
    '@' || new.username || coalesce(' — ' || new.display_name, ''));
  return new;
exception when others then
  return new;   -- сборка текста не должна ронять саму регистрацию
end $$;

drop trigger if exists trg_notify_new_user_t on public.profiles;
create trigger trg_notify_new_user_t after insert on public.profiles
  for each row execute function public.trg_notify_new_user();

/** Альбом реально попал в очередь модератора: опубликован и ждёт 'pending'.
    Условие совпадает с фильтром mod_pending_albums — republish уже одобренного
    альбома (после «В черновики» и публикации заново) второй раз не дёргает. */
create or replace function public.trg_notify_album_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare author text;
begin
  select username into author from profiles where id = new.author_id;
  perform notify_telegram(
    '🖼 Новый альбом на проверку' || chr(10) ||
    '«' || left(new.title, 120) || '» — @' || coalesce(author, '?') || chr(10) ||
    coalesce(new.category || ' · ', '') ||
    new.photos_count || 'ф ' || new.videos_count || 'в ' || new.audio_count || 'а');
  return new;
exception when others then
  return new;   -- сборка текста не должна ронять публикацию альбома
end $$;

drop trigger if exists trg_notify_album_review_t on public.albums;
create trigger trg_notify_album_review_t after update on public.albums
  for each row
  when (new.published_at is not null and old.published_at is null and new.moderation_status = 'pending')
  execute function public.trg_notify_album_review();

/** Новая жалоба. */
create or replace function public.trg_notify_report()
returns trigger language plpgsql security definer set search_path = public as $$
declare reporter text; target text;
begin
  select username into reporter from profiles where id = new.reporter_id;
  target := case new.subject_type
    when 'album' then (
      select '«' || left(a.title, 80) || '» — @' || p.username
      from albums a join profiles p on p.id = a.author_id where a.id = new.subject_id)
    when 'post' then (
      select coalesce(left(po.caption, 80), '(без подписи)') || ' — @' || p.username
      from posts po join profiles p on p.id = po.author_id where po.id = new.subject_id)
    when 'comment' then (
      select '«' || left(c.body, 80) || '» — @' || p.username
      from comments c join profiles p on p.id = c.author_id where c.id = new.subject_id)
    when 'profile' then (select '@' || username from profiles where id = new.subject_id)
    else null
  end;

  perform notify_telegram(
    '🚩 Жалоба: ' || new.subject_type || ' · ' || new.reason::text || chr(10) ||
    'от @' || coalesce(reporter, '?') || chr(10) ||
    coalesce(target, '(не найдено)') ||
    coalesce(chr(10) || '«' || left(new.note, 200) || '»', ''));
  return new;
exception when others then
  return new;   -- сборка текста не должна ронять отправку жалобы
end $$;

drop trigger if exists trg_notify_report_t on public.reports;
create trigger trg_notify_report_t after insert on public.reports
  for each row execute function public.trg_notify_report();

-- ---------------------------------------------------------------- гранты

revoke execute on function public.notify_telegram(text)         from public, anon, authenticated;
revoke execute on function public.trg_notify_new_user()         from public, anon, authenticated;
revoke execute on function public.trg_notify_album_review()     from public, anon, authenticated;
revoke execute on function public.trg_notify_report()           from public, anon, authenticated;
