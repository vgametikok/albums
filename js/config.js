// Публичная конфигурация. Ключ publishable — публичный по дизайну,
// вся защита данных лежит на RLS/RPC (см. ARCHITECTURE.md §8).
export const SUPABASE_URL = 'https://rizveurkjpcwrmbtoawj.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_vpoMQyLN_a1CeYBPuGIuIA_VI5x07JD';

export const CATEGORIES = ['Travel', 'Music', 'Family', 'Art', 'Sport', 'Other'];

export const LIMITS = {
  photo: 10 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  slides: 10,
};
