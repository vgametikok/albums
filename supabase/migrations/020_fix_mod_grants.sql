-- 020: КРИТИЧЕСКИЙ фикс грантов модерации (найдено 2026-07-21 при аудите грантов
-- на шаге 2 переезда R2).
--
-- Проблема: функции mod_* (миграция 018) задумывались «без грантов, только под
-- service-ключом», но по факту оказались доступны ролям anon и authenticated
-- через PostgREST. Причина — Supabase раздаёт execute новым функциям своими
-- `alter default privileges ... grant`, и опора 018 на встречный revoke-default
-- из 015 не сработала (грантодатель другой). Проверено has_function_privilege:
-- до этой миграции has_function_privilege('anon', 'mod_ban', 'execute') = true.
--
-- Последствия ДО фикса (эксплуатируемо любым, у кого публичный ключ — а он в
-- config.js): POST /rest/v1/rpc/mod_session_create -> сминтить себе сессию
-- модератора -> полный доступ через mod-api; либо напрямую mod_ban (забанить
-- кого угодно), mod_open_subject (прочитать любое приватное), mod_hide,
-- mod_resolve, mod_queue — всё в обход проверки пароля, которая живёт только
-- в edge-функции.
--
-- Лечение: явный revoke (не полагаемся на default privileges). service_role
-- сохраняет execute (его доступ не через PUBLIC), поэтому mod-api под
-- service-ключом продолжает работать без изменений.
--
-- На будущее: КАЖДАЯ новая definer-функция, которая должна быть service-only,
-- обязана нести собственный явный `revoke execute ... from public, anon,
-- authenticated` в своей миграции (как это делает 019 и теперь эта). Полагаться
-- на alter default privileges из 015 НЕЛЬЗЯ.

revoke execute on function
  public.mod_queue(int, int),
  public.mod_open_subject(text, uuid, text),
  public.mod_hide(text, uuid, boolean, text, text),
  public.mod_ban(uuid, boolean, text, text),
  public.mod_resolve(uuid, text, text, text),
  public.mod_note_attempt(text, boolean),
  public.mod_recent_fails(text),
  public.mod_session_create(text, text, text),
  public.mod_session_check(text)
from public, anon, authenticated;
