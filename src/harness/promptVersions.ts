// Промпты живут в prompts/, а не в коде: чтобы попробовать другую редакцию, достаточно
// положить рядом файл со следующей версией и переключить ACTIVE_PROMPTS — правок в коде
// агентов и харнесса это не требует.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Какая версия промпта уходит в прогон. Единственное место, где это решается. */
export const ACTIVE_PROMPTS = { coach: 'v8', reviewer: 'v8', triage: 'v1' } as const;

export type PromptRole = keyof typeof ACTIVE_PROMPTS;

/** Что уехало в прогон — попадает в результат, чтобы по нему можно было отличить прогоны. */
export type PromptVersions = Record<PromptRole, string>;

// Роль → имя файла. Роли короткие (их видно в результате), файлы названы по агентам.
const PROMPT_FILES: Record<PromptRole, string> = {
  coach: 'healthCoach',
  reviewer: 'safetyReviewer',
  triage: 'triage',
};

// cwd, а не import.meta.url: после сборки этот модуль лежит внутри .next/.
const PROMPTS_DIR = join(process.cwd(), 'prompts');

/**
 * Читает промпт с диска на каждый вызов: файл маленький, а прогон и так идёт секунды —
 * зато отредактированный промпт подхватывается без перезапуска сервера.
 */
export function loadPrompt(role: PromptRole, version: string): string {
  const path = join(PROMPTS_DIR, `${PROMPT_FILES[role]}.${version}.md`);
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(`Не найден промпт «${role}» версии ${version}: ожидался файл ${path}`);
  }
}

/** Копия активных версий: результат прогона не должен ссылаться на живую константу. */
export function activePromptVersions(): PromptVersions {
  return { ...ACTIVE_PROMPTS };
}
