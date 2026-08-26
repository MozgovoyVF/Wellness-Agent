// Стриминговый роут чата: тот же прогон, что и /api/agent/run, но рассказанный по ходу.
// Роут ничего не решает про прогон — он вызывает runOS() и переводит его события в части
// потока, а затем стримит готовый план. Роутинг намерения и обновление памяти живут
// в runOS (src/os/runOS.ts), а не в харнессе и не здесь.

import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamWriter } from 'ai';
import { runOS } from '@/src/os/runOS';
import type { AgentEvent } from '@/src/harness/events';
import { stepIds, type ResultData, type Step, type WellnessUIMessage } from '../../chat-protocol';

// Агенты читают и пишут файлы в data/ и поднимают дочерние процессы MCP — нужен
// nodejs-рантайм, не edge. То же, что у /api/agent/run.
export const runtime = 'nodejs';

// Прогон идёт от двадцати секунд до нескольких минут: каждый раунд — два похода
// в модель, а раундов до трёх. Дефолтный потолок платформы такое обрежет на середине.
export const maxDuration = 300;

// Как часто переписывается живое превью черновика. Перезаписывать его на каждую дельту
// нельзя: часть data-части заменяется целиком, и план в 3 КБ при посимвольных дельтах
// (их приходит около полусотни на абзац) вылился бы в сотни килобайт трафика на воздух.
const DRAFT_THROTTLE_MS = 150;
const DRAFT_TAIL = 200;

// Пауза между строками готового плана. Нужна, чтобы стрим читался как печать, а не как
// мгновенная вставка; на длинном плане добавляет секунду-полторы — после минуты работы
// цикла это незаметно.
const PLAN_LINE_DELAY_MS = 12;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Текст сообщения чата: части складываются, нетекстовые пропускаются. */
function textOf(message: WellnessUIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

/**
 * Перевод событий харнесса в шаги таймлайна. Единственное место, где AgentEvent
 * превращается в data-часть, — вся таблица соответствия живёт здесь.
 *
 * Шаги хранятся целиком, а не патчами: запись data-части с тем же id ЗАМЕНЯЕТ данные,
 * а не сливает их, и «дописать статус» к шагу можно только отправив его заново со всеми
 * полями. Отсюда карта состояний: put сливает патч с прошлым состоянием шага и пишет
 * результат. Без неё обновление статуса стирало бы phase у плана и tool у вызова.
 */
function createStepWriter(writer: UIMessageStreamWriter<WellnessUIMessage>, run: string) {
  const ids = stepIds(run);
  const steps = new Map<string, Step>();

  const put = (id: string, patch: Partial<Step> & Pick<Step, 'kind'>) => {
    const next = { round: null, status: 'running', ...steps.get(id), ...patch } as Step;
    steps.set(id, next);
    writer.write({ type: 'data-step', id, data: next });
  };

  // Черновик копится здесь, а в поток уезжает не чаще раза в DRAFT_THROTTLE_MS.
  const drafts = new Map<number, string>();
  let lastDraftAt = 0;

  const flushDraft = (round: number, force: boolean) => {
    const text = drafts.get(round);
    if (text === undefined) return;

    const now = Date.now();
    if (!force && now - lastDraftAt < DRAFT_THROTTLE_MS) return;
    lastDraftAt = now;

    put(ids.plan(round), {
      kind: 'plan',
      draft: { chars: text.length, tail: text.slice(-DRAFT_TAIL) },
    });
  };

  let toolIndex = 0;
  let finalizeStarted = false;

  return {
    handle(event: AgentEvent) {
      switch (event.type) {
        case 'module':
          // Классификация мгновенна: «в процессе» такого шага не бывает, поэтому сразу
          // done. Отсюда же иконка в рейке вместо кружка состояния — как у тула.
          put(ids.module, {
            kind: 'module',
            status: 'done',
            round: null,
            module: { name: event.name, confidence: event.confidence },
          });
          return;

        case 'triage':
          // Пройденный триаж — не шаг, а отсутствие препятствия: показывать «задача
          // допущена» на каждый прогон значит забить таймлайн строкой, которая всегда
          // одинакова. Завёрнутый триаж — единственное, что стоит увидеть.
          if (event.blocked) {
            put(ids.triage, {
              kind: 'triage',
              status: 'done',
              round: null,
              blocked: { reason: event.reason ?? 'Задача требует живого специалиста.' },
            });
          }
          return;

        case 'round-start':
          put(ids.plan(event.round), {
            kind: 'plan',
            status: 'running',
            round: event.round,
            phase: event.kind,
          });
          return;

        case 'tool':
          toolIndex += 1;
          put(ids.tool(toolIndex), {
            kind: 'tool',
            status: 'done',
            round: event.round,
            tool: { name: event.name, args: event.args, source: event.source },
          });
          return;

        case 'plan-delta':
          drafts.set(event.round, (drafts.get(event.round) ?? '') + event.delta);
          flushDraft(event.round, false);
          return;

        case 'review-start':
          // Раунд дописан. Сброс превью принудительный: если последние дельты пришли
          // внутри окна троттлинга, без force они потерялись бы на самом видном месте —
          // на последних строках плана.
          flushDraft(event.round, true);
          put(ids.plan(event.round), { kind: 'plan', status: 'done' });
          put(ids.review(event.round), { kind: 'review', status: 'running', round: event.round });
          return;

        case 'review-done':
          put(ids.review(event.round), { kind: 'review', status: 'done', review: event.review });
          return;

        case 'finalize':
          finalizeStarted = true;
          put(ids.finalize, { kind: 'finalize', status: 'running', round: null });
          return;
      }
    },

    /** Закрепляющий заход не имеет своего события конца — его конец это конец прогона. */
    finish() {
      if (finalizeStarted) put(ids.finalize, { kind: 'finalize', status: 'done' });
    },
  };
}

/** Что из результата прогона едет в консоль. План сюда не входит — он уезжает текстом. */
function toResultData(result: Awaited<ReturnType<typeof runOS>>): ResultData {
  return {
    verdict: result.review.verdict,
    score: result.review.score,
    issues: result.review.issues,
    rounds: result.rounds.map((state) => ({
      round: state.round,
      verdict: state.review.verdict,
      score: state.review.score,
    })),
    finalRound: result.finalRound,
    toolCalls: result.toolCalls,
    toolSources: result.toolSources,
    retrievals: result.retrievals,
    promptVersions: result.promptVersions,
    module: result.module,
    intentConfidence: result.intentConfidence,
    durationMs: result.durationMs,
    improved: result.improved,
  };
}

export async function POST(request: Request) {
  let messages: WellnessUIMessage[];
  try {
    ({ messages } = await request.json());
  } catch {
    return Response.json({ error: 'Тело запроса не является валидным JSON.' }, { status: 400 });
  }

  // Задача — последнее сообщение человека, и только оно. Прошлые сообщения роут
  // не читает намеренно: runHealthAgent принимает строку, и склеить в неё транскрипт
  // значило бы протащить его через триаж и ревьюера, которые судят по полю «Задача».
  // Почему так решено — в docs/superpowers/specs/2026-08-20-chat-streaming-design.md.
  const task = [...(messages ?? [])].reverse().find((message) => message.role === 'user');
  const text = task ? textOf(task) : '';

  if (!text) {
    return Response.json({ error: 'Укажи задачу.' }, { status: 400 });
  }

  const run = randomRunId();
  const ids = stepIds(run);

  const stream = createUIMessageStream<WellnessUIMessage>({
    execute: async ({ writer }) => {
      const steps = createStepWriter(writer, run);

      const result = await runOS(text, { onEvent: (event) => steps.handle(event) });
      steps.finish();

      // План стримится ПОСЛЕ цикла и берётся из result.plan, а не из дельт: наружу
      // уезжает finalRound — последний одобренный раунд, а он не обязан быть последним.
      // Дельты выше показывали черновик; здесь едет ровно тот текст, что признан итогом.
      //
      // Режем по строкам, а не по символам: app/plan-markdown.tsx разбирает markdown
      // построчно, и посимвольный стрим показывал бы «#» и «**» сырыми до конца строки.
      if (result.plan) {
        writer.write({ type: 'text-start', id: ids.text });
        for (const line of result.plan.split(/(?<=\n)/)) {
          writer.write({ type: 'text-delta', id: ids.text, delta: line });
          await sleep(PLAN_LINE_DELAY_MS);
        }
        writer.write({ type: 'text-end', id: ids.text });
      }

      writer.write({ type: 'data-result', id: ids.result, data: toResultData(result) });
    },
    // По умолчанию SDK прячет текст ошибки, чтобы не утекли серверные детали. Здесь
    // прятать нечего и вредно: отсутствие DEEPSEEK_API_KEY или недоступный MCP-сервер —
    // это то, что человек чинит сам за минуту, если ему сказать.
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка.';
      console.error(`Ошибка прогона: ${message}`);
      return message;
    },
  });

  return createUIMessageStreamResponse({ stream });
}

/** Короткий идентификатор прогона: нужен только для префикса id частей в пределах сессии. */
function randomRunId(): string {
  return crypto.randomUUID().slice(0, 8);
}
