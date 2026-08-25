// Маршрутизация намерения: какой модуль возьмёт задачу.
//
// Один заход в модель и одна строка ответа — «nutrition 0.8». Больше здесь нет ничего
// намеренно: ни второго прохода, ни переписывания запроса, ни голосования. Каждое такое
// «мелкое улучшение» добавляет ещё один поход в модель и ещё одно место, где выдача
// меняется незаметно, а цена ошибки здесь мала — не тот модуль означает не ту наслойку,
// а не пропущенную опасность.
//
// Как спросить модель, модуль не знает: это приезжает коллбэком, ровно как у triageTask
// и validateReview. Так политика захода живёт отдельно от SDK.

import { GENERAL, MODULES, moduleByName, type Module } from './modules';

/**
 * Ниже этого порога специализация не применяется — идём general.
 *
 * Порог держит КОД, и в промпте роутера его нет вовсе. Это прямой урок APPROVE_SCORE:
 * пока планка стояла в промпте ревьюера, модель считала сумму сама и подгоняла оси под
 * неё, и понижение не сработало ни разу за 39 прогонов. Впишешь число в
 * prompts/router.v1.md — получишь то же самое, только с confidence.
 */
export const MODULE_CONFIDENCE = 0.6;

export type Intent = { module: Module; confidence: number };

/** Как спросить модель. Строка на входе — готовый запрос, строка на выходе — сырой ответ. */
export type AskRouter = (input: string) => Promise<string>;

// Имя модуля, пробел, число от 0 до 1. Запятая как разделитель дробной части допущена:
// модель отвечает по-русски, и «0,8» она пишет охотно.
const ANSWER = /^([A-Za-z][A-Za-z0-9]*)\s+([01](?:[.,]\d+)?)$/;

/** Список модулей для промпта роутера. Собирается из реестра, а не пишется руками. */
export function moduleCatalog(): string {
  return MODULES.map((module) => `- ${module.name} — ${module.description}`).join('\n');
}

/** Осечка разбора. Отдельной функцией, чтобы причина попадала в лог одинаково. */
function fallback(reason: string, confidence = 0): Intent {
  console.log(`   роутер: ${reason} — идём ${GENERAL.name}`);
  return { module: GENERAL, confidence };
}

/**
 * Классифицирует задачу. Никогда не бросает: любая неудача — неизвестное имя, число
 * не на месте, пустой ответ, исключение по дороге — сводится к general.
 *
 * Это не небрежность, а то же правило, по которому непонятный ответ триажа пропускает
 * задачу дальше: за осечкой роутера стоит рабочее поведение по умолчанию, и ронять
 * из-за неё прогон, который человек ждёт, значит менять ценное на служебное.
 */
export async function classifyIntent(task: string, ask: AskRouter): Promise<Intent> {
  let answer: string;
  try {
    answer = await ask(`## Модули\n${moduleCatalog()}\n\n## Задача\n${task}`);
  } catch (error) {
    return fallback(`заход не удался (${String(error)})`);
  }

  // Берём первую непустую строку: модель иногда добавляет вторую с пояснением,
  // и разбирать её незачем — контракт требует одной.
  const line = answer
    .trim()
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);

  if (line === undefined) return fallback('пустой ответ');

  const match = ANSWER.exec(line);
  if (match === null) return fallback(`ответ не разобран («${line}»)`);

  const found = moduleByName(match[1]);
  if (found === null) return fallback(`нет модуля «${match[1]}»`);

  const confidence = Number(match[2].replace(',', '.'));
  if (!Number.isFinite(confidence)) return fallback(`уверенность не число («${match[2]}»)`);

  if (confidence < MODULE_CONFIDENCE) {
    // Уверенность сохраняем ту, что назвала модель: в трейсе должно быть видно не только
    // «пошли general», но и насколько близко было к порогу.
    return fallback(`${found.name} ${confidence} ниже порога ${MODULE_CONFIDENCE}`, confidence);
  }

  console.log(`   роутер: ${found.name} ${confidence}`);
  return { module: found, confidence };
}
