'use client';

// Чат с агентом: задача → живой таймлайн этапов → план → вердикт. Одна сессия на странице,
// история прогонов копится в состоянии и никуда не сохраняется.
//
// Компонент ничего не решает про прогон. Что происходит, ему рассказывает поток из
// app/api/chat/route.ts частями data-step; итог приезжает частью data-result, план —
// обычной текстовой частью. Форма всего этого объявлена в app/chat-protocol.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { renderPlan } from './plan-markdown';
import type { ResultData, Step, WellnessUIMessage } from './chat-protocol';

// Границы цикла. Продублированы из runHealthAgent.ts: харнесс — серверный модуль,
// тянуть из него значения в браузерный бандл нельзя. Меняешь там — меняй здесь.
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 3;

// Заготовки собраны из профиля и дневника: колено, лактоза, поздний отбой,
// обед в контейнере. Клик отправляет формулировку целиком.
const PRESETS = [
  { chip: 'ужин на сегодня', task: 'Составь ужин на сегодня, чтобы вечером не тянуло на сладкое.' },
  { chip: 'тренировка щадя колено', task: 'Собери тренировку на сегодня, которая не нагружает правое колено.' },
  { chip: 'лечь до полуночи', task: 'Что поменять в вечере, чтобы лечь до полуночи после переработки.' },
  { chip: 'обед в контейнер', task: 'Составь обед в контейнер на завтра из того, что я люблю.' },
];

// Имя тула → что оно значит по-русски. Продублировано из src/mcp/toolNames.ts и src/skills/:
// это серверные модули, тянуть из них имена в браузерный бандл нельзя. Добавил тул —
// добавь строку сюда, иначе в таймлайне он покажется как неизвестный.
const TOOL_LABELS: Record<string, string> = {
  read_profile: 'прочитал профиль',
  read_recent_logs: 'поднял дневник',
  list_recipes: 'заглянул в рецепты',
  save_health_plan: 'сохранил план',
  append_daily_log: 'дописал в дневник',
  suggestWorkoutTemplate: 'взял шаблон тренировки',
  generateShoppingList: 'собрал список покупок',
  searchKnowledge: 'искал в базе знаний',
  openmeteo_search_locations: 'нашёл координаты города',
  openmeteo_get_forecast: 'запросил прогноз погоды',
  list_directory: 'посмотрел папку',
  read_text_file: 'прочитал файл',
  write_file: 'записал файл',
  'API-post-search': 'поискал страницу в Notion',
  'API-retrieve-a-page': 'открыл страницу Notion',
  'API-post-page': 'создал страницу в Notion',
  'API-patch-block-children': 'дописал в страницу Notion',
};

// Оба имени здесь не подписи, а условия, и продублированы по той же причине.
// searchKnowledge — из src/rag/searchKnowledgeTool.ts: по нему строка таймлайна
// подменяется на сам запрос. API-post-page — из src/mcp/toolNames.ts: по нему решается,
// показывать ли кнопку «в notion». Разъедутся — оба поведения отвалятся молча.
const SEARCH_KNOWLEDGE = 'searchKnowledge';
const NOTION_CREATE_PAGE = 'API-post-page';

// Имя модуля → подпись по-русски. Продублировано из src/os/modules/ по той же причине,
// что и TOOL_LABELS: консоль клиентская, серверный модуль в браузерный бандл не тянут.
// Модуль без строки здесь покажется своим машинным именем — это не поломка, но и не то,
// что человек должен читать.
const MODULE_LABELS: Record<string, string> = {
  general: 'без специализации',
  dailyPlan: 'план на день',
  nutrition: 'питание',
  recipes: 'что приготовить',
  training: 'тренировки',
  recovery: 'восстановление',
  habits: 'привычки',
  shoppingList: 'список покупок',
  knowledge: 'объяснение',
};

// Здесь это не подпись, а условие: по нему строка таймлайна и трейс различают
// «роутер выбрал модуль» и «специализации нет». Продублировано из src/os/modules/general.ts.
const GENERAL_MODULE = 'general';

// Откуда взялся инструмент. Для агента разницы нет — он зовёт их одинаково, — и ровно
// поэтому её стоит показать: иначе не видно, что половина инструментов живёт в отдельных
// процессах за стандартным протоколом, а один ходит в чужую базу по сети.
type ToolKind = 'mcp' | 'rag' | 'skill';

const KIND_LABELS: Record<ToolKind, string> = { mcp: 'mcp', rag: 'rag', skill: 'навык' };

/**
 * Вид инструмента по его источнику. RAG проверяется первым и по имени: тул локальный,
 * источника у него нет, и без этой ветки он был бы неотличим от навыка в коде.
 *
 * Источник передаёт вызывающий, а не карта внутри: у живого шага он приезжает
 * в самом событии, у строки трейса берётся из toolSources итога. Раньше здесь стояла
 * карта, и живой таймлайн, у которого её ещё нет, звал навыком каждый MCP-тул.
 */
function kindOf(name: string, source: string | null): { kind: ToolKind; source: string | null } {
  if (name === SEARCH_KNOWLEDGE) return { kind: 'rag', source: 'knowledge' };
  return source !== null ? { kind: 'mcp', source } : { kind: 'skill', source: null };
}

type Tone = 'jade' | 'amber' | 'coral';

const TONES: Record<ResultData['verdict'], Tone> = {
  approve: 'jade',
  revise: 'amber',
  needs_human_professional: 'coral',
};

const VERDICT_WORDS: Record<ResultData['verdict'], string> = {
  approve: 'Одобрено',
  revise: 'На доработке',
  needs_human_professional: 'К специалисту',
};

/** Сохранение по кнопке: одно действие, четыре состояния и ничего больше. */
type NotionState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'done'; url: string }
  | { status: 'error'; message: string };

function plural(count: number, forms: [string, string, string]) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} с`;

/** Запрос из аргументов searchKnowledge. Аргументы приходят сырой строкой от SDK. */
function queryOf(args: string): string | null {
  try {
    const parsed = JSON.parse(args) as { query?: unknown };
    return typeof parsed.query === 'string' ? parsed.query : null;
  } catch {
    return null;
  }
}

// ─── Иконки ───────────────────────────────────────────────────────────────────
// Inline svg, а не эмодзи: эмодзи рисует системный шрифт, поэтому лупа на macOS,
// Windows и Android — три разные картинки разного веса, и ни одна не красится
// currentColor. Штрих у всех трёх один, размер задаётся по месту.

function IconSearch() {
  return (
    <svg
      className="icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.4 15.4 21 21" />
    </svg>
  );
}

function IconArrowUp() {
  return (
    <svg
      className="icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19.5V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  );
}

/**
 * Иконки видов инструмента. Три силуэта выбраны так, чтобы различаться с одного взгляда
 * при 14 px: вилка (подключён снаружи, отдельный процесс), искра (нашлось по смыслу)
 * и фигурные скобки (функция здесь, в коде). Вид по-прежнему кодируется формой, а не
 * цветом — цвет на этой странице говорит только о вердикте ревьюера.
 */
function IconPlug() {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 2.6v4M15 2.6v4" />
      <rect x="5.4" y="6.6" width="13.2" height="6.2" rx="2.6" />
      <path d="M12 12.8v4.2" />
    </svg>
  );
}

function IconSparkle() {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.4C12.5 8.6 15.4 11.5 20.6 12 15.4 12.5 12.5 15.4 12 20.6 11.5 15.4 8.6 12.5 3.4 12 8.6 11.5 11.5 8.6 12 3.4Z" />
    </svg>
  );
}

function IconBraces() {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.2 3.4c-2 0-3 1-3 3v2.2c0 1.5-.8 2.5-2 3 1.2.5 2 1.5 2 3V17c0 2 1 3 3 3" />
      <path d="M14.8 3.4c2 0 3 1 3 3v2.2c0 1.5.8 2.5 2 3-1.2.5-2 1.5-2 3V17c0 2-1 3-3 3" />
    </svg>
  );
}

/**
 * Метка шага маршрутизации. Компас, а не четвёртый вид инструмента: это не источник
 * тула, а решение о направлении, и в KIND_ICONS ему делать нечего. Силуэт выбран так же,
 * как остальные три, — чтобы читался при 14 px.
 */
function IconCompass() {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" />
      <path d="m15.4 8.6-2.2 4.6-4.6 2.2 2.2-4.6z" />
    </svg>
  );
}

const KIND_ICONS: Record<ToolKind, () => React.JSX.Element> = {
  mcp: IconPlug,
  rag: IconSparkle,
  skill: IconBraces,
};

function KindIcon({ kind }: { kind: ToolKind }) {
  const Glyph = KIND_ICONS[kind];
  return <Glyph />;
}

/**
 * Происхождение инструмента одной меткой: вид и, если он чужой, имя сервера.
 * Иконку метка несёт только в трейсе — в таймлайне та же иконка стоит в рейке слева
 * и служит меткой шага, потому что вызов тула не бывает «в процессе»: роут пишет его
 * сразу готовым, и кружок состояния на такой строке всегда одинаков и не значит ничего.
 */
function KindChip({ kind, source, icon = false }: { kind: ToolKind; source: string | null; icon?: boolean }) {
  return (
    <span className="kind">
      {icon && <KindIcon kind={kind} />}
      <span className="kind__type">{KIND_LABELS[kind]}</span>
      {source !== null && <span className="kind__source">{source}</span>}
    </span>
  );
}

function IconChevronDown() {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  );
}

/** Разбор ассистентского сообщения на три вещи, из которых оно состоит. */
function readRun(message: WellnessUIMessage) {
  const steps: Step[] = [];
  let plan = '';
  let result: ResultData | null = null;

  for (const part of message.parts) {
    if (part.type === 'data-step') steps.push(part.data);
    else if (part.type === 'data-result') result = part.data;
    else if (part.type === 'text') plan += part.text;
  }

  return { steps, plan, result };
}

// ─── Таймлайн ─────────────────────────────────────────────────────────────────

function ModuleStep({ step }: { step: Step }) {
  if (!step.module) return null;

  const general = step.module.name === GENERAL_MODULE;
  const label = MODULE_LABELS[step.module.name] ?? step.module.name;

  // Порядок тот же, что у строки тула: метка вида в рейке, действие человеческими
  // словами, машинное имя вторым планом. Уверенность стоит справа и приглушена —
  // это число для того, кто разбирается, а не для того, кто читает план.
  return (
    <>
      <span className="step__kind" aria-hidden="true">
        <IconCompass />
      </span>
      <span className="step__gloss">
        {general ? 'без специализации' : `модуль: ${label}`}
        <span className="step__tool mono">{step.module.name}</span>
      </span>
      <span className="step__conf mono">{step.module.confidence.toFixed(1)}</span>
    </>
  );
}

function PlanStep({ step }: { step: Step }) {
  const word =
    step.phase === 'revise'
      ? `переписывает по замечаниям · раунд ${step.round}`
      : step.phase === 'reinforce'
        ? `усиливает одобренный · раунд ${step.round}`
        : `пишет план · раунд ${step.round}`;

  return (
    <>
      <span className="step__name">{word}</span>
      {step.draft && step.status === 'running' && (
        <span className="step__draft">
          <span className="step__chars mono">{step.draft.chars} знаков</span>
          <span className="step__tail">{step.draft.tail}</span>
        </span>
      )}
    </>
  );
}

function ToolStep({ step }: { step: Step }) {
  if (!step.tool) return null;
  const { kind, source } = kindOf(step.tool.name, step.tool.source);
  const query = step.tool.name === SEARCH_KNOWLEDGE ? queryOf(step.tool.args) : null;

  // Порядок читается как фраза: чем это сделано, что сделано, чем именно. Имя тула
  // стоит после действия и приглушено — человеку важнее «прочитал профиль», чем
  // read_profile, а машинное имя нужно тем, кто разбирается, и им хватит второго плана.
  return (
    <>
      <span className="step__kind" aria-hidden="true">
        <KindIcon kind={kind} />
      </span>
      <span className="step__src">
        <KindChip kind={kind} source={source} />
      </span>
      {/* Действие и имя тула — один поток текста, а не два флекс-элемента: у длинного
          запроса к базе знаний иначе переносится только текст, а имя уезжает на новую строку
          к левому краю и повисает там само по себе. */}
      <span className="step__gloss">
        {query !== null ? (
          <>
            <IconSearch />
            {query}
          </>
        ) : (
          (TOOL_LABELS[step.tool.name] ?? 'неизвестный тул')
        )}
        <span className="step__tool mono">{step.tool.name}</span>
      </span>
    </>
  );
}

function ReviewStep({ step }: { step: Step }) {
  if (step.status === 'running' || !step.review) {
    return <span className="step__name">ревьюер смотрит план · раунд {step.round}</span>;
  }

  return (
    <>
      <span className="step__name">ревью · раунд {step.round}</span>
      <span className={`step__verdict is-${TONES[step.review.verdict]}`}>
        {step.review.verdict}
        {step.review.verdict !== 'needs_human_professional' && (
          <span className="step__score mono">{step.review.score}/10</span>
        )}
      </span>
    </>
  );
}

function Timeline({ steps, live }: { steps: Step[]; live: boolean }) {
  if (steps.length === 0) return null;

  const rounds = new Set(steps.filter((step) => step.round !== null).map((step) => step.round)).size;
  const summary = `${steps.length} ${plural(steps.length, ['шаг', 'шага', 'шагов'])}${
    rounds > 0 ? ` · ${rounds} ${plural(rounds, ['раунд', 'раунда', 'раундов'])}` : ''
  }`;

  const list = (
    <ol className="timeline">
      {steps.map((step, index) => (
        <li className={`step step--${step.kind} is-${step.status}`} key={index}>
          {step.kind !== 'tool' && step.kind !== 'module' && (
            <span className="step__mark" aria-hidden="true" />
          )}
          {step.kind === 'module' && <ModuleStep step={step} />}
          {step.kind === 'plan' && <PlanStep step={step} />}
          {step.kind === 'tool' && <ToolStep step={step} />}
          {step.kind === 'review' && <ReviewStep step={step} />}
          {step.kind === 'finalize' && <span className="step__name">сохраняет одобренный план</span>}
          {step.kind === 'triage' && (
            <span className="step__name">триаж завернул задачу: {step.blocked?.reason}</span>
          )}
        </li>
      ))}
    </ol>
  );

  // Живой таймлайн развёрнут, отработавший сворачивается: пять прогонов по десять
  // строк — это экран, по которому невозможно двигаться, а ответ здесь не таймлайн,
  // а план под ним.
  if (live) return <div className="timeline__live">{list}</div>;

  return (
    <details className="timeline__past">
      <summary className="timeline__head mono">
        <span className="timeline__title">ход работы</span>
        <span className="timeline__sum">{summary}</span>
      </summary>
      {list}
    </details>
  );
}

// ─── Итог прогона ─────────────────────────────────────────────────────────────

function Trace({ result }: { result: ResultData }) {
  const { toolCalls, rounds, verdict } = result;

  // Запрос к базе знаний живёт не в toolCalls (там одни имена), а в отдельном журнале.
  // Сшиваем их по порядку: и то и другое пишется в порядке вызова, поэтому n-й
  // searchKnowledge в списке тулов — это n-я запись журнала.
  let searches = 0;
  const rows = toolCalls.map((name, index) => ({
    name,
    index,
    ...kindOf(name, result.toolSources[name] ?? null),
    retrieval: name === SEARCH_KNOWLEDGE ? result.retrievals[searches++] : undefined,
  }));

  return (
    <details className="trace">
      <summary className="trace__head mono">
        <span className="trace__title">трейс прогона</span>
        <span className="trace__sum">
          {rounds.length} {plural(rounds.length, ['раунд', 'раунда', 'раундов'])}
          {verdict !== 'needs_human_professional' && ` · score ${result.score}`}
          {toolCalls.length > 0 &&
            ` · ${toolCalls.length} ${plural(toolCalls.length, ['вызов', 'вызова', 'вызовов'])}`}{' '}
          · {seconds(result.durationMs)}
        </span>
      </summary>

      {/* Оценка раунда — это качество плана. Там, где плана нет, вместо числа прочерк.
          Итоговый раунд помечен: при доборе до минимума наружу уезжает не последний. */}
      <ol className="trace__rounds">
        {rounds.map((state) => (
          <li className="trace__round mono" key={state.round}>
            <span className="trace__no">раунд {state.round}</span>
            <span className="trace__verdict">
              {state.verdict}
              {rounds.length > 1 && state.round === result.finalRound && (
                <span className="trace__final">итог</span>
              )}
            </span>
            <span className="trace__score">
              {state.verdict === 'needs_human_professional' ? '—' : `${state.score}/10`}
            </span>
          </li>
        ))}
      </ol>

      {toolCalls.length > 0 && (
        <>
          {/* Легенда объясняет метки один раз. Она же — предмет урока: тулы для агента
              одинаковы, а живут по-разному, и в трейсе это должно быть видно. */}
          <div className="tools__head mono">
            <p className="tools__title">что сделал агент</p>
            <ul className="legend">
              <li className="legend__item">
                <IconPlug />
                mcp — отдельный процесс
              </li>
              <li className="legend__item">
                <IconSparkle />
                rag — поиск по базе знаний
              </li>
              <li className="legend__item">
                <IconBraces />
                навык — функция в коде
              </li>
            </ul>
          </div>
          <ol className="tools">
            {rows.map(({ name, index, kind, source, retrieval }) => (
              <li className="tools__item mono" key={index}>
                <span className="tools__no">{index + 1}</span>
                <span className="tools__src">
                  <KindChip kind={kind} source={source} icon />
                </span>
                <span className="tools__name">{name}</span>
                <span className="tools__gloss">{TOOL_LABELS[name] ?? 'неизвестный тул'}</span>

                {retrieval && (
                  <div className="found">
                    <p className="found__query">
                      <IconSearch />
                      <span>
                        knowledge: {retrieval.query} → {retrieval.chunks.length} chunks
                      </span>
                    </p>
                    {retrieval.chunks.length > 0 && (
                      <ul className="found__list">
                        {retrieval.chunks.map((chunk, position) => (
                          <li key={position}>
                            <span className="found__sim">{chunk.similarity.toFixed(2)}</span>
                            <span className="found__file">{chunk.file}</span>
                            <span className="found__head">{chunk.heading}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}

      <p className="trace__meta mono">
        модуль {result.module}
        {result.module !== GENERAL_MODULE && ` (${MODULE_LABELS[result.module] ?? result.module})`}
        {' · уверенность '}
        {result.intentConfidence.toFixed(1)}
        {' · промпты: coach '}
        {result.promptVersions.coach} · reviewer {result.promptVersions.reviewer} · triage{' '}
        {result.promptVersions.triage} · router {result.promptVersions.router}
        {result.improved && ' · оценка выросла за раунды'}
      </p>
    </details>
  );
}

function Verdict({ result }: { result: ResultData }) {
  const tone = TONES[result.verdict];
  const blocked = result.verdict === 'needs_human_professional';

  return (
    <div className={`verdict is-${tone}`}>
      <p className="verdict__word">{VERDICT_WORDS[result.verdict]}</p>
      {/* Оценка — это качество плана. Когда плана нет, показывать её значит врать:
          оценивать нечего. То же правило, что в харнессе. */}
      {!blocked && (
        <p className="verdict__score mono">
          оценка <b>{result.score}</b> из 10 · раунд {result.finalRound} из {result.rounds.length}
          {result.rounds.length < MAX_ROUNDS && ` (минимум ${MIN_ROUNDS}, потолок ${MAX_ROUNDS})`}
        </p>
      )}
      {result.issues.length > 0 && (
        <ul className="verdict__issues">
          {result.issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Плана нет и не будет: задача вне велнеса. Защитный контур, показанный как есть. */
function Specialist({ result }: { result: ResultData }) {
  return (
    <div className="specialist">
      <p className="specialist__head">Требуется специалист</p>
      <p className="specialist__note">
        Задача выходит за пределы велнеса — питания, тренировок, восстановления и привычек. План
        не составлен и наружу не отдаётся. Переформулируй задачу или иди к врачу.
      </p>
      {result.issues.length > 0 && (
        <ul className="specialist__issues">
          {result.issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Сообщение прогона ────────────────────────────────────────────────────────

function RunMessage({
  message,
  live,
  canSaveToNotion,
}: {
  message: WellnessUIMessage;
  live: boolean;
  canSaveToNotion: boolean;
}) {
  const { steps, plan, result } = readRun(message);
  const [copied, setCopied] = useState(false);
  const [notion, setNotion] = useState<NotionState>({ status: 'idle' });

  const blocked = result?.verdict === 'needs_human_professional';

  async function copyPlan() {
    try {
      await navigator.clipboard.writeText(plan);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  // Сохранение по кнопке идёт мимо агента: роут сам зовёт тулы notion-сервера. Модель
  // здесь не участвует, поэтому ответ приходит за секунду, а не за минуту.
  async function saveToNotion() {
    setNotion({ status: 'saving' });
    try {
      const response = await fetch('/api/plan/notion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const data = await response.json();
      if (!response.ok) {
        setNotion({
          status: 'error',
          message: data.error ?? `Сервер ответил статусом ${response.status}.`,
        });
      } else {
        setNotion({ status: 'done', url: data.url });
      }
    } catch {
      setNotion({ status: 'error', message: 'Не удалось связаться с сервером.' });
    }
  }

  return (
    <article className="msg msg--agent">
      <Timeline steps={steps} live={live} />

      {blocked && result ? (
        <Specialist result={result} />
      ) : (
        plan && <div className="paper">{renderPlan(plan)}</div>
      )}

      {result && !blocked && <Verdict result={result} />}

      {result && !blocked && plan && (
        <div className="msg__acts">
          {/* Кнопка «в notion» стоит только на последнем одобренном плане, и это
              не косметика: /api/plan/notion сверяет текст с data/output.md, где лежит
              план последнего одобренного прогона. На старом сообщении она давала бы 409. */}
          {canSaveToNotion &&
            (notion.status === 'done' ? (
              <a className="copy" href={notion.url} target="_blank" rel="noreferrer">
                открыть в notion ↗
              </a>
            ) : (
              <button className="copy" onClick={saveToNotion} disabled={notion.status === 'saving'}>
                {notion.status === 'saving' ? 'сохраняю…' : 'в notion'}
              </button>
            ))}
          <button className="copy" onClick={copyPlan}>
            {copied ? 'скопировано' : 'скопировать'}
          </button>
        </div>
      )}

      {notion.status === 'error' && (
        <p className="msg__error mono" role="status">
          {notion.message}
        </p>
      )}

      {result && <Trace result={result} />}
    </article>
  );
}

// ─── Чат ──────────────────────────────────────────────────────────────────────

export function Chat() {
  const { messages, sendMessage, status, setMessages, error } = useChat<WellnessUIMessage>({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
    // Дельты плана приходят построчно, а превью черновика — раз в 150 мс. Без троттлинга
    // React перерисовывал бы всю историю прогонов на каждую из них.
    throttle: 60,
  });

  const [input, setInput] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const running = status === 'submitted' || status === 'streaming';

  // Прилипаем к низу только если человек и так там. Ушёл вверх читать прошлый прогон —
  // страница за ним не тянется: без истории это была бы придирка, с историей —
  // обязательное поведение.
  const onScroll = useCallback(() => {
    const node = logRef.current;
    if (!node) return;
    setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 100);
  }, []);

  useEffect(() => {
    if (!atBottom) return;
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, atBottom]);

  // Поле растёт под текст, но не бесконечно — верхняя граница задана в CSS.
  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [input]);

  function send(task: string) {
    if (!task.trim() || running) return;
    sendMessage({ text: task.trim() });
    setInput('');
    setAtBottom(true);
  }

  function newSession() {
    if (running) return;
    setMessages([]);
    setInput('');
    setAtBottom(true);
    inputRef.current?.focus();
  }

  // Кнопка «в notion» — только на последнем прогоне с одобренным планом. Ищем его id
  // один раз здесь: сообщение о себе такого знать не может, это свойство всей сессии.
  const lastApproved = [...messages]
    .reverse()
    .find((message) =>
      message.parts.some((part) => part.type === 'data-result' && part.data.verdict === 'approve'),
    );

  const notionConfigured = (message: WellnessUIMessage) => {
    const result = message.parts.find((part) => part.type === 'data-result');
    if (result?.type !== 'data-result') return false;
    // Сервер notion в прогоне поднимался — значит, токен настроен. Агент уже создал
    // страницу сам — второй копии не надо.
    return (
      result.data.toolSources[NOTION_CREATE_PAGE] !== undefined &&
      !result.data.toolCalls.includes(NOTION_CREATE_PAGE)
    );
  };

  return (
    <div className="chat">
      {/* Шапка — знак и выход в новый чат, больше ничего. Про контекст, раунды и
          ревью рассказывает сам прогон, как только начинается; повторять это
          планкой над пустым экраном значит занимать место под то, что и так
          появится через секунду. Знак дышит, пока агент работает: индикатор,
          видимый с любого места ленты. */}
      <header className={`topbar${running ? ' is-running' : ''}`}>
        <span className="topbar__mark">
          <span className="topbar__dot" aria-hidden="true" />
          wellness
        </span>
        <button className="copy" onClick={newSession} disabled={running || messages.length === 0}>
          новый чат
        </button>
      </header>

      <div className="chat__log" ref={logRef} onScroll={onScroll}>
        {messages.length === 0 && (
          <div className="empty">
            <span className="empty__orb" aria-hidden="true" />
            <p className="empty__ask">Чем помочь?</p>
            <ul className="presets">
              {PRESETS.map((preset) => (
                <li key={preset.chip}>
                  <button className="preset" onClick={() => send(preset.task)}>
                    {preset.chip}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {messages.map((message, index) =>
          message.role === 'user' ? (
            <p className="msg msg--you" key={message.id}>
              {message.parts
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')}
            </p>
          ) : (
            <RunMessage
              key={message.id}
              message={message}
              live={running && index === messages.length - 1}
              canSaveToNotion={message.id === lastApproved?.id && notionConfigured(message)}
            />
          ),
        )}

        {/* Пока прогон не дошёл до первого события, показать нечего — но молчать нельзя:
            между отправкой и первым шагом проходит несколько секунд. */}
        {status === 'submitted' && <p className="msg msg--wait mono">поднимаю агентов…</p>}

        {error && (
          <p className="msg msg--error mono" role="status">
            {error.message}
          </p>
        )}
      </div>

      {!atBottom && (
        <button
          className="chat__down"
          aria-label="Вниз, к последнему сообщению"
          onClick={() => {
            setAtBottom(true);
            const node = logRef.current;
            if (node) node.scrollTop = node.scrollHeight;
          }}
        >
          <IconChevronDown />
        </button>
      )}

      {/* Поле ввода — стеклянная капсула, кнопка отправки круглая и без подписи.
          Иконка без текста обязана назваться словами для скринридера, отсюда
          aria-label; ⇧↵ для переноса строки — конвенция любого чата, и строкой
          подсказки под полем её объяснять больше не нужно. */}
      <div className="composer">
        <textarea
          ref={inputRef}
          className="composer__input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send(input);
            }
          }}
          disabled={running}
          rows={1}
          placeholder={running ? 'Идёт прогон…' : 'Спросите что-нибудь'}
        />
        <button
          className="composer__send"
          aria-label={running ? 'Идёт прогон' : 'Отправить'}
          onClick={() => send(input)}
          disabled={running || !input.trim()}
        >
          {running ? <span className="composer__spin" aria-hidden="true" /> : <IconArrowUp />}
        </button>
      </div>
    </div>
  );
}
