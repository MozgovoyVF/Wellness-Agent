// Навык «профиль»: чистая функция над data/profile.md. Обёртки tool() здесь больше нет —
// модели профиль показывает MCP-сервер (src/mcp/markdownHealthServer.ts, тул read_profile).
// Функция осталась и используется дважды: сервером и харнессом, который кладёт профиль
// в контекст ревьюера напрямую — там это не тул агента, а сборка входа.

import { readData } from './dataFiles';

/** Профиль целиком: он небольшой и нарезать его нечем — разделы независимы. */
export function getProfile(): string {
  return readData('profile.md');
}
