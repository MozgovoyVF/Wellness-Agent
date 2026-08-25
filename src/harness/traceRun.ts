// Персистентный след прогона. Всё, что харнесс знает о заходе, живёт ровно до ответа
// API — после этого сравнить сегодняшний прогон со вчерашним нечем. Трейс кладёт тот же
// результат на диск: по нему прогон переигрывается (scripts/replay.ts) и диффается.
//
// Модуль ничего не решает про сам прогон и ничего из него не читает сверх результата:
// его роль — запись, и падать он не имеет права (см. traceRun ниже).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Retrieval } from '../rag';
import type { PromptVersions } from './promptVersions';
import type { RoundState } from './rounds';
import type { Review } from './validateReview';

// Сколько символов плана попадает в трейс. Трейс читают глазами и диффают, а не
// восстанавливают из него план: целиком одобренный план лежит в data/output.md.
const EXCERPT_LENGTH = 500;

// cwd, а не import.meta.url: после сборки этот модуль лежит внутри .next/.
const RUNS_DIR = join(process.cwd(), 'runs');

/** Раунд в трейсе: план урезан до выдержки, вердикт сохраняется целиком. */
export type TraceRound = {
  round: number;
  /** Первые EXCERPT_LENGTH символов плана; null — плана нет, см. redactPlans. */
  planExcerpt: string | null;
  review: Review;
};

/** Формат файла runs/run-*.json. Его же читает scripts/replay.ts. */
export type RunTrace = {
  runId: string;
  task: string;
  promptVersions: PromptVersions;
  model: string;
  /**
   * Модуль, которым шёл прогон. У трейсов, снятых до появления OS, поля нет — читающая
   * сторона обязана это переживать (см. scripts/replay.ts).
   */
  module: string;
  /**
   * Уверенность роутера, как её назвала модель. На прогон не влияла: по ней выбиралась
   * наслойка промпта и длина списка тулов, но не вердикт. Лежит в трейсе, чтобы
   * маршрутизацию можно было разобрать задним числом — например, увидеть, что задачи
   * определённого вида систематически не дотягивают до порога.
   */
  intentConfidence: number;
  rounds: TraceRound[];
  toolCalls: string[];
  /**
   * Имя тула → сервер, который его дал. Нужен, чтобы по трейсу было видно не только что
   * агент звал, но и откуда это взялось: наш markdown-health, чужой weather или локальный
   * навык. Отдельным полем, а не префиксом в toolCalls: имена там сравниваются
   * с константами, и трейсы прошлых прогонов должны читаться прежним replay.
   */
  toolSources: Record<string, string>;
  /**
   * Чем агент пользовался в базе знаний: запрос и заголовки найденного, по порядку
   * обращений. По одному имени «searchKnowledge» в toolCalls этого не восстановить,
   * а именно здесь видно, на что опирался план. Тел chunks тут нет — только заголовки
   * и числа, поэтому урезать запись, в отличие от планов, не приходится.
   */
  retrievals: Retrieval[];
  finalScore: number;
  verdict: Review['verdict'];
  durationMs: number;
  createdAt: string;
};

/** Что харнесс отдаёт наружу — ровно те поля результата, которые едут в трейс. */
type TracedResult = {
  review: Review;
  rounds: RoundState[];
  finalScore: number;
  toolCalls: string[];
  toolSources: Record<string, string>;
  retrievals: Retrieval[];
  promptVersions: PromptVersions;
  module: string;
  intentConfidence: number;
  durationMs: number;
};

// Двоеточия и точка из ISO не годятся для имени файла, но порядок сортировки терять
// не хочется — поэтому замена посимвольная, а не своя сборка даты.
const fileStamp = (iso: string) => iso.replace(/[:.]/g, '-');

const excerpt = (plan: string | null) => (plan === null ? null : plan.slice(0, EXCERPT_LENGTH));

/**
 * Пишет трейс прогона в runs/ и возвращает путь к файлу (null, если записать не вышло).
 *
 * Ошибка записи не роняет прогон: план уже составлен, проверен и отдан человеку — терять
 * его из-за полного диска или прав на папку было бы обменом ценного на служебное. Поэтому
 * catch глухой, а о неудаче видно в логе.
 */
export function traceRun(task: string, result: TracedResult): string | null {
  const createdAt = new Date().toISOString();
  const runId = `run-${fileStamp(createdAt)}`;

  // Модель читается здесь, а не на уровне модуля: в скриптах .env загружается в теле
  // первого импорта, а тела модулей выполняются раньше — константа взяла бы дефолт.
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

  const trace: RunTrace = {
    runId,
    task,
    promptVersions: result.promptVersions,
    model,
    module: result.module,
    intentConfidence: result.intentConfidence,
    // Плана нет там, где его нет и в ответе: при needs_human_professional история уже
    // прошла redactPlans, и защитный контур доезжает до диска сам, отдельной ветки не надо.
    rounds: result.rounds.map((state) => ({
      round: state.round,
      planExcerpt: excerpt(state.plan),
      review: state.review,
    })),
    toolCalls: result.toolCalls,
    toolSources: result.toolSources,
    retrievals: result.retrievals,
    finalScore: result.finalScore,
    verdict: result.review.verdict,
    durationMs: result.durationMs,
    createdAt,
  };

  const path = join(RUNS_DIR, `${runId}.json`);
  try {
    mkdirSync(RUNS_DIR, { recursive: true });
    writeFileSync(path, `${JSON.stringify(trace, null, 2)}\n`);
    console.log(`Трейс прогона: runs/${runId}.json`);
    return path;
  } catch (error) {
    console.log(`Трейс записать не удалось (прогон это не отменяет): ${String(error)}`);
    return null;
  }
}
