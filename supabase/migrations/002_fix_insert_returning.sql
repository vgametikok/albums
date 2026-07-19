-- Фикс: INSERT ... RETURNING падал с "new row violates row-level security policy".
--
-- Причина: для RETURNING Postgres применяет SELECT-политику к новой строке. Политики
-- на albums/posts/media вызывали can_view_*(id, ...), а те делают запрос В ТУ ЖЕ таблицу —
-- вставляемая строка своему же запросу в этот момент ещё не видна, проверка даёт false.
--
-- Лечение: добавить прямую проверку владельца по колонкам новой строки. Семантику
-- не меняет — can_view_* и так возвращают true для автора/владельца, но теперь этот
-- случай вычисляется без обращения к таблице.

drop policy if exists albums_read on albums;
create policy albums_read on albums for select
  using (author_id = auth.uid() or can_view_album(id, auth.uid()));

drop policy if exists posts_read on posts;
create policy posts_read on posts for select
  using (author_id = auth.uid() or can_view_post(id, auth.uid()));

drop policy if exists media_read on media;
create policy media_read on media for select
  using (owner_id = auth.uid() or can_view_media(id, auth.uid()));

drop table if exists diag_twin;
