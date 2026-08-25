// Слой OS: маршрутизация намерения до прогона, обновление памяти после.
//
//   task → classifyIntent → runHealthAgent(с модулем) → memory update
//
// ИНВАРИАНТ СИСТЕМЫ, который здесь виден целиком: Safety Reviewer обязателен для КАЖДОГО
// модуля и ни одним из них не параметризуется. Модуль меняет промпт коуча и длину списка
// его тулов — и всё; триаж, ревьюер, порог одобрения, гейт на запись и порядок раундов
// живут внутри runHealthAgent и про модуль не знают. Специализация не может ослабить
// проверку, потому что не имеет к ней доступа. Проверяется это тремя eval-кейсами,
// один из которых — задача, которую защитный контур обязан остановить при выбранном
// модуле (evals/cases/module-recovery-stop.json).
//
// Мультиагентной оркестрации здесь нет и не должно быть: агент один, конфигураций много.
// Handoffs и подагенты завели бы восемь дорог мимо ревьюера.

import { run } from '@openai/agents';
import { createRouter } from '../agents/intentRouter';
import { configureClient } from '../harness/client';
import { createEmitter } from '../harness/events';
import { activePromptVersions, loadPrompt } from '../harness/promptVersions';
import { runHealthAgent, type HealthAgentResult, type RunOptions } from '../harness/runHealthAgent';
import { updateMemory } from './memory';
import { preferenceSignal } from './preferenceSignal';
import { classifyIntent } from './router';

export type { HealthAgentResult, RunOptions };

/**
 * Прогон целиком, как его видит приложение. Единственная точка входа для роутов
 * и evals: runHealthAgent остаётся публичным, но ходят через него только replay
 * и те, кому маршрутизация не нужна.
 */
export async function runOS(task: string, options: RunOptions = {}): Promise<HealthAgentResult> {
  // Клиент нужен уже роутеру — он ходит в модель раньше прогона. Настройка идемпотентна,
  // повторный вызов внутри runHealthAgent ничего не делает.
  configureClient();

  const emitter = createEmitter(options.onEvent);
  const versions = activePromptVersions();
  const router = createRouter(loadPrompt('router', versions.router));

  // Маршрутизация стоит ДО триажа, а не после. Так «Модуль: восстановление» появляется
  // в таймлайне сразу, а не через два похода в модель. Цена — завёрнутая триажем задача
  // платит один дешёвый вызов, около секунды: защитный контур от этого не сдвигается,
  // он просто срабатывает следующим шагом.
  const intent = await classifyIntent(task, async (input) =>
    String((await run(router, input)).finalOutput ?? ''),
  );

  emitter.send({ type: 'module', name: intent.module.name, confidence: intent.confidence });

  const result = await runHealthAgent(task, {
    ...options,
    module: intent.module,
    intentConfidence: intent.confidence,
  });

  // Память пополняется только тем, что прошло ревьюера. Завёрнутый или недоработанный
  // план — это не то, что человеку предлагали делать, и следа в дневнике он оставлять
  // не должен.
  if (result.review.verdict === 'approve' && result.plan !== null) {
    await updateMemory({
      task,
      module: intent.module.name,
      plan: result.plan,
      score: result.finalScore,
      preference: preferenceSignal(task),
    });
  }

  return result;
}
