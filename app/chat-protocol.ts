// Контракт между стриминговым роутом и консолью: что роут кладёт в поток и что консоль
// оттуда читает. Общий модуль, а не два согласованных вручную описания, — потому что
// разъехавшись, они дали бы молча пустой таймлайн: TypeScript о расхождении не узнает,
// если обе стороны описывают форму сами.
//
// Модуль обязан оставаться типами и константами. Он импортируется клиентским компонентом,
// и любая исполняемая строка отсюда уедет в браузерный бандл; типы из src/ втягиваются
// через `import type` и стираются при сборке — так же, как это делала прежняя консоль.

import type { UIMessage } from 'ai';
import type { PromptVersions } from '@/src/harness/promptVersions';
import type { Review } from '@/src/harness/validateReview';
import type { Retrieval } from '@/src/rag';

/** Что за шаг стоит в таймлайне. Один тип на все шаги: таймлайн — плоский список. */
export type StepKind = 'module' | 'triage' | 'tool' | 'plan' | 'review' | 'finalize';

export type Step = {
  kind: StepKind;
  status: 'running' | 'done';
  /** Раунд, к которому относится шаг. У триажа и закрепляющего захода раунда нет. */
  round: number | null;
  /**
   * Только у kind: 'plan'. Различает «пишет план», «переписывает по замечаниям» и
   * «усиливает одобренный» — это и есть отдельный шаг «Revising (раунд N)». Вычислить
   * его снаружи по номеру раунда нельзя: добор до минимума идёт уже после approve,
   * и второй раунд бывает обоими.
   */
  phase?: 'first' | 'revise' | 'reinforce';
  /**
   * Только у kind: 'module'. Какой модуль выбрал роутер и насколько был уверен.
   * name === 'general' означает «без специализации»: либо роутер так решил, либо
   * уверенность не дотянула до порога. Отдельного флага под это нет — он выводится
   * из имени.
   */
  module?: { name: string; confidence: number };
  /**
   * Только у kind: 'tool'. args — сырая строка, как её отдал SDK; source — имя
   * MCP-сервера или null у локального тула. Источник едет в самом шаге, а не берётся
   * из toolSources в ResultData: тот приезжает только с итогом, а шаг надо показать
   * сразу — иначе живой таймлайн зовёт навыком каждый MCP-тул.
   */
  tool?: { name: string; args: string; source: string | null };
  /**
   * Только у kind: 'plan'. Живое превью черновика: сколько знаков уже написано и хвост
   * текста. Черновик, а не план: наружу уедет finalRound, а он не обязан быть последним.
   */
  draft?: { chars: number; tail: string };
  /** Только у kind: 'review'. Приходит после enforceApproveThreshold. */
  review?: Review;
  /** Только у kind: 'triage' и только когда задача завёрнута. */
  blocked?: { reason: string };
};

/**
 * Итог прогона для показа. Это НЕ HealthAgentResult: поля plan здесь нет намеренно —
 * план уезжает текстовой частью сообщения, и вторая его копия в data-части означала бы
 * два источника истины для одного текста. Раунды урезаны до вердикта и оценки: тексты
 * планов консоли не нужны, а при needs_human_professional их там и нет.
 */
export type ResultData = {
  verdict: Review['verdict'];
  score: number;
  issues: string[];
  rounds: { round: number; verdict: Review['verdict']; score: number }[];
  finalRound: number;
  toolCalls: string[];
  toolSources: Record<string, string>;
  retrievals: Retrieval[];
  promptVersions: PromptVersions;
  module: string;
  intentConfidence: number;
  durationMs: number;
  improved: boolean;
};

/** Сообщение чата с нашими data-частями. Метаданных у сообщений нет — отсюда never. */
export type WellnessUIMessage = UIMessage<never, { step: Step; result: ResultData }>;

/**
 * Идентификаторы частей потока. Стабильный id — это реконсиляция: повторная запись
 * с тем же id обновляет часть на месте (running → done, растущее превью), а не добавляет
 * вторую. Собираются здесь, а не строками по месту, потому что их пишет роут, а сверяет
 * с ними консоль.
 *
 * Префикс прогона обязателен. Сессия копит прогоны в одном списке сообщений, и если
 * реконсиляция data-частей скоупится шире текущего сообщения, третий прогон затрёт
 * вердикт первого. Проверять это живым багом дорого, префикс стоит нисколько.
 */
export const stepIds = (run: string) => ({
  module: `${run}:module`,
  triage: `${run}:triage`,
  plan: (round: number) => `${run}:plan-${round}`,
  review: (round: number) => `${run}:review-${round}`,
  /** Счётчик сквозной по прогону, а не по раунду: повторный read_profile во втором
   *  раунде обязан стать новой строкой, а не обновить строку из первого. */
  tool: (index: number) => `${run}:tool-${index}`,
  finalize: `${run}:finalize`,
  text: `${run}:plan-text`,
  result: `${run}:result`,
});
