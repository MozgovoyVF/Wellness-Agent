// Промпты живут в prompts/, а не в коде: чтобы попробовать другую редакцию, достаточно
// положить рядом файл со следующей версией и переключить ACTIVE_PROMPTS — правок в коде
// агентов и харнесса это не требует.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Какая версия промпта уходит в прогон. Единственное место, где это решается. */
export const ACTIVE_PROMPTS = {
  coach: 'v8',
  reviewer: 'v8',
  triage: 'v1',
  router: 'v1',
} as const;

export type PromptRole = keyof typeof ACTIVE_PROMPTS;

/** Что уехало в прогон — попадает в результат, чтобы по нему можно было отличить прогоны. */
export type PromptVersions = Record<PromptRole, string>;

// Роль → имя файла. Роли короткие (их видно в результате), файлы названы по агентам.
const PROMPT_FILES: Record<PromptRole, string> = {
  coach: 'healthCoach',
  reviewer: 'safetyReviewer',
  triage: 'triage',
  router: 'router',
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

// Наслойки модулей лежат отдельной папкой и версий в смысле ACTIVE_PROMPTS не имеют:
// редакцию выбирает поле promptFile в самом модуле (src/os/modules/). Хочешь попробовать
// другую — положи nutrition.v2.md и поменяй одну строку в модуле.
const MODULES_DIR = join(PROMPTS_DIR, 'modules');

/**
 * Промпт-наслойка модуля. Приклеивается к базовому промпту коуча, а не заменяет его:
 * формат плана разбирают три независимых парсера, и описан он должен быть один раз.
 *
 * Бросает, как и loadPrompt: модуль, объявивший файл, которого нет, — это поломка
 * конфигурации, а не повод молча пойти без специализации.
 */
export function loadModulePrompt(file: string): string {
  const path = join(MODULES_DIR, file);
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(`Не найдена наслойка модуля: ожидался файл ${path}`);
  }
}
