// Один заход коуча: стриминговый, когда за прогоном кто-то следит, и обычный, когда нет.
//
// Это второе и последнее место, где харнесс разбирает внутренности SDK. Первое —
// src/harness/toolCalls.ts, и они друг другу пара: там события захода читаются постфактум
// из newItems, здесь — по мере поступления из потока. Ответственность одна, форм две,
// потому что двумя способами их отдаёт SDK. Третьего места быть не должно.
//
// Почему вообще понадобился поток. collectToolCalls вызывается ПОСЛЕ того, как заход
// закончился, — значит, имена тулов физически появляются одной пачкой через минуту после
// того, как коуч их позвал. Для трейса это неважно, для живого таймлайна — это и есть
// разница между «оживает по мере работы» и «стоит, потом всё разом».

import { run, type RunItem } from '@openai/agents';
import type { createCoach } from '../agents/healthCoach';
import type { Emitter } from './events';

type Coach = ReturnType<typeof createCoach>;

/**
 * То, что цикл берёт от захода: имена тулов собирает collectToolCalls из newItems,
 * текст плана — из finalOutput. Форма общая у RunResult и StreamedRunResult, поэтому
 * цикл не знает, каким из двух путей пришёл ответ, и не должен знать.
 */
export type CoachOutput = { newItems: RunItem[]; finalOutput: unknown };

export type CoachRunOptions = {
  emitter: Emitter;
  /** Номер раунда для событий. У закрепляющего захода раунда нет — там null. */
  round: number | null;
  maxTurns: number;
  /**
   * Карта «тул → сервер» от connectMcpServers. Нужна ровно для того, чтобы событие
   * вызова несло источник сразу: сам по себе поток SDK о происхождении тула не знает,
   * а снаружи карта появляется только с итогом прогона.
   */
  toolSources: Record<string, string>;
};

export async function runCoach(
  coach: Coach,
  input: string,
  { emitter, round, maxTurns, toolSources }: CoachRunOptions,
): Promise<CoachOutput> {
  // Никто не слушает — идём прежним путём, тем же вызовом, что стоял в цикле до всей
  // этой затеи. По нему ходят evals, replay и /api/agent/run, и он обязан остаться
  // ровно таким: расхождение между «как проверяли» и «как работает» здесь стоило бы
  // дороже всего, что стриминг даёт.
  if (!emitter.active) {
    return run(coach, input, { maxTurns });
  }

  const stream = await run(coach, input, { maxTurns, stream: true });

  for await (const event of stream) {
    // Тул позвали. Событие приходит в момент вызова, а не после захода, — ради этого
    // всё и затевалось. args отдаём сырой строкой: что с ней делать, решает тот,
    // кто знает конкретный тул, а харнесс такого знания не держит.
    if (event.type === 'run_item_stream_event') {
      if (event.name === 'tool_called' && event.item.rawItem.type === 'function_call') {
        const name = event.item.rawItem.name;
        emitter.send({
          type: 'tool',
          round,
          name,
          args: event.item.rawItem.arguments,
          // Тула нет ни у одного сервера — значит, он локальный: навык или RAG.
          source: toolSources[name] ?? null,
        });
      }
      continue;
    }

    // Текст плана по кускам. Фильтр именно по типу, а не по «есть ли строковое поле
    // delta»: рядом в том же потоке идут сырые провайдерские события (type: 'model'),
    // которых на порядок больше, и утиная типизация утащила бы в план их содержимое.
    if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
      if (round !== null && event.data.delta.length > 0) {
        emitter.send({ type: 'plan-delta', round, delta: event.data.delta });
      }
    }
  }

  // Поток кончился — но досчитать заход обязан SDK: до completed finalOutput пуст.
  await stream.completed;

  return { newItems: stream.newItems, finalOutput: stream.finalOutput };
}
