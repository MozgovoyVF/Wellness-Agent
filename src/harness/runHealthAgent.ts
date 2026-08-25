// Оркестратор харнесса: собирает клиент, промпты, агентов, MCP-сервер и цикл в один прогон.
// Вся оркестрация живёт здесь, в коде: сколько будет раундов — не меньше минимума и не
// больше максимума — и что делать с вердиктом, решает цикл ниже, а не текст промптов.
// Единственная точка входа: сюда ходит роут app/api/agent/run.
//
// Здесь же — жизненный цикл MCP-серверов: данные и инструменты коуч берёт из отдельных
// процессов, и поднять их перед первым раундом и погасить после последнего может только
// тот, кто владеет прогоном целиком. Какие это серверы — здесь не написано и не должно
// быть: их список живёт в src/mcp/servers.config.ts.

import { run } from '@openai/agents';
import { createCoach } from '../agents/healthCoach';
import { createReviewer } from '../agents/safetyReviewer';
import { createTriage } from '../agents/safetyTriage';
import {
  createGate,
  getPreferences,
  getProfile,
  getRecentLog,
  localCoachTools,
  LOCAL_WRITE_TOOLS,
  planMatchesDisk,
  savePlan,
} from '../skills';
import { connectMcpServers, sourceOf } from '../mcp/connectServers';
import { MCP_TOOLS } from '../mcp/toolNames';
import { mcpWriteToolNames } from '../mcp/servers.config';
import { GENERAL, type Module } from '../os/modules';
import { createRetrievalLog, createSearchKnowledgeTool, type Retrieval } from '../rag';
import { calendarBlock } from './calendar';
import { configureClient } from './client';
import { createEmitter, type AgentEventHandler } from './events';
import {
  activePromptVersions,
  loadModulePrompt,
  loadPrompt,
  type PromptVersions,
} from './promptVersions';
import { createRoundLog, redactPlans, type RoundState } from './rounds';
import { finalRound, improvedAcrossRounds } from './score';
import { runCoach } from './streamCoach';
import { collectToolCalls } from './toolCalls';
import { traceRun } from './traceRun';
import { triageTask } from './triage';
import { humanProfessionalReview, validateReview, type Review } from './validateReview';

// Минимум сильнее одобрения: даже одобренный план идёт ещё раз к коучу на усиление,
// пока раундов не наберётся столько. Максимум — потолок, дальше которого цикл не идёт.
const DEFAULT_MIN_ROUNDS = 1;
const DEFAULT_MAX_ROUNDS = 3;

// Потолок шагов внутри одного захода агента. Дефолтных десяти впритык: коуч тратит
// по шагу на каждый тул, и упереться в потолок он должен только если зациклился.
const MAX_TURNS = 12;

// Сколько дней дневника видит ревьюер. Заведомо больше, чем возьмёт коуч: увидев меньше,
// ревьюер завернёт как выдумку факт, который коуч честно взял из дня за пределами окна.
const REVIEWER_LOG_DAYS = 14;

// Сколько записей предпочтений едет в контекст коуча и ревьюера. Хвост, а не файл
// целиком: он растёт с каждым «запомни», а место в контексте конечно. Константа стоит
// здесь, рядом с REVIEWER_LOG_DAYS: это граница прогона, а не свойство файла.
const PREFERENCE_ENTRIES = 10;

// Тулы записи всех источников — MCP-серверов и локальных навыков. Собираются один раз
// на модуль, а не на прогон: конфиг за время работы процесса не меняется.
//
// Зачем список: модуль OS может отнять у коуча любой тул, КРОМЕ пишущего. Ими командует
// только гейт, и модуль, забывший вписать save_health_plan, иначе молча ломал бы
// сохранение одобренного плана — поломка, которую не поймают ни сборка, ни mcp:inspect.
const WRITE_TOOLS = new Set([...mcpWriteToolNames(), ...LOCAL_WRITE_TOOLS]);

// Порог одобрения: сумма пяти осей чек-листа. Начиная с safetyReviewer.v8 эта цифра
// не названа в промпте вовсе — ревьюер выносит вердикт качественно, а числовую планку
// держит только код. Так и задумывалось с самого начала («score модель не называет»),
// но пока промпт сообщал ей порог, она подгоняла оси под него: за 39 прогонов сумма
// ни разу не опустилась ниже 8, то есть ниже самого порога, и понижение не срабатывало
// ни разу. Девять, а не восемь: восьмёрку берёт любой план, который заполнил шаблон
// коуча, — на такой планке цикл всегда заканчивался одним раундом.
const APPROVE_SCORE = 9;

export type { Review, RoundState };

/** Границы цикла. Минимум добирает качество, максимум держит потолок. */
export type RoundLimits = {
  /** Раундов будет не меньше этого, даже если план одобрили раньше. */
  minRounds?: number;
  maxRounds?: number;
};

/**
 * Что можно попросить у прогона. onEvent — единственная добавка ради стриминга:
 * слушатель хода работы, которому харнесс рассказывает о себе, пока цикл идёт.
 * Он опционален, и в этом весь смысл — без него прогон ведёт себя ровно как прежде,
 * включая тот же не-стриминговый вызов коуча (см. streamCoach.ts).
 */
export type RunOptions = RoundLimits & {
  onEvent?: AgentEventHandler;
  /**
   * Конфигурация модуля OS: промпт-наслойка и суженный список тулов. Не передан —
   * general, то есть поведение до появления модулей. Необязателен намеренно: по этому
   * пути ходят replay и прямые вызовы харнесса, и они не обязаны знать про роутер.
   */
  module?: Module;
  /**
   * Уверенность роутера, как её назвала модель. На прогон не влияет вовсе — едет
   * в результат и оттуда в трейс, чтобы по трейсу можно было разобрать маршрутизацию.
   * Приезжает параметром, хотя runOS знает её раньше: трейс пишется из finish(),
   * единственной точки сборки результата, и второй способ записи завёл бы второй формат.
   */
  intentConfidence?: number;
};

export type HealthAgentResult = {
  /** null, если задача требует живого специалиста — такой план наружу не отдаём. */
  plan: string | null;
  /** Вердикт итогового раунда — того, чей план поехал наружу. */
  review: Review;
  /** История всех раундов, от первого к последнему. */
  rounds: RoundState[];
  /** Номер итогового раунда: при доборе он не обязан быть последним. */
  finalRound: number;
  /** Оценка итогового раунда. */
  finalScore: number;
  /** Выросла ли оценка от первого раунда к последнему. */
  improved: boolean;
  /** Имена тулов, которые коуч вызвал за прогон, по порядку и со всеми повторами. */
  toolCalls: string[];
  /**
   * Имя тула → сервер, который его дал: markdown-health, filesystem, weather, notion.
   * Тула нет в карте — значит, он локальный. Лежит рядом с toolCalls, а не подмешан
   * в имена: имена в toolCalls сравниваются с константами (см. страховку на save_health_plan
   * ниже), и префикс в них сломал бы и сравнение, и чтение старых трейсов.
   */
  toolSources: Record<string, string>;
  /**
   * Обращения коуча к базе знаний, по порядку: запрос и заголовки найденного. Лежит
   * отдельно от toolCalls, потому что имён там мало — по одному «searchKnowledge»
   * не видно, что именно агент искал и на что в итоге опёрся.
   */
  retrievals: Retrieval[];
  /** С какими версиями промптов шёл этот прогон. */
  promptVersions: PromptVersions;
  /** Модуль, которым шёл прогон. При прямом вызове харнесса — 'general'. */
  module: string;
  /** Уверенность роутера. При прямом вызове харнесса — 0. */
  intentConfidence: number;
  durationMs: number;
};

// ─── Вход агентов ─────────────────────────────────────────────────────────────

const issueList = (issues: string[]) => issues.map((issue) => `- ${issue}`).join('\n');

/**
 * Что коуч получает на вход. Профиля и дневника здесь нет намеренно: он достаёт их
 * тулами сам и берёт ровно столько, сколько нужно задаче. Случаев три, а не два: план
 * пишется с нуля, правится по замечаниям или — когда одобрение уже есть, а минимум
 * раундов ещё не пройден — усиливается. Просить «устрани замечания» там, где замечаний
 * нет, значит толкнуть коуча переписать одобренное вслепую.
 */
function buildCoachInput(
  task: string,
  calendar: string,
  preferences: string,
  previous: RoundState | null,
): string {
  // Календарь и предпочтения идут первыми и в каждом раунде: день недели коучу неоткуда
  // взять, а на втором раунде он нужен ровно так же, как на первом.
  const base =
    `${calendar}\n\n## Подтверждённые предпочтения\n${preferences}\n\n## Задача\n${task}`;
  if (previous === null) return base;

  const withPlan = `${base}\n\n## Твой прошлый план\n${previous.plan}`;

  if (previous.review.verdict === 'approve') {
    return (
      `${withPlan}\n\n## Что сделать\nПлан уже одобрен ревьюером — не переписывай его заново.\n` +
      'Сохрани структуру и всё, что в нём работает, и усиль слабые места: где не хватает\n' +
      'конкретики — добавь её, где формулировка размыта — уточни.'
    );
  }

  return (
    `${withPlan}\n\n## Замечания ревьюера\n${issueList(previous.review.issues)}\n\n` +
    'Перепиши план, устранив каждое замечание.'
  );
}

/**
 * Что ревьюер получает на вход. Профиль и дневник кладёт харнесс, а не тулы: ревьюер —
 * контур безопасности, и инструментов у него нет (почему — в src/agents/safetyReviewer.ts).
 * Со второго раунда показываем его же прошлые замечания: без них он каждый раунд смотрит
 * на переписанный план свежим взглядом и выдвигает новые требования того же калибра —
 * ворота уезжают, и цикл не сходится. При пустом списке (так бывает после approve) блок
 * не нужен: показывать нечего.
 */
function buildReviewerInput(context: string, plan: string, previous: RoundState | null): string {
  const base = `${context}\n\n## План коуча\n${plan}`;
  if (previous === null || previous.review.issues.length === 0) return base;

  return `${base}\n\n## Что ты требовал исправить в прошлой версии\n${issueList(previous.review.issues)}`;
}

/**
 * Что коуч получает в закрепляющем заходе — единственном, где гейт открыт. План передаём
 * готовым и просим не трогать: этот заход существует ради побочных эффектов, а не ради
 * нового текста. Условие про список покупок держит харнесс, потому что оно про задачу
 * пользователя, а коуч в этот момент видит только план.
 *
 * Имя MCP-тула берётся из константы, а не пишется строкой: переименуют тул на сервере —
 * коуч получит указание позвать то, чего в списке нет, и просьба провалится молча.
 */
function buildFinalizeInput(task: string, plan: string): string {
  return (
    `## Задача, которую ты решал\n${task}\n\n## Одобренный план\n${plan}\n\n## Что сделать\n` +
    'Ревьюер одобрил этот план — записывать теперь можно.\n' +
    `1. Вызови ${MCP_TOOLS.saveHealthPlan} и передай ему план целиком, ровно в том виде,\n` +
    '   в каком он выше.\n' +
    '2. Если человек просил список покупок или план не выполнить без закупки — вызови\n' +
    '   generateShoppingList с тем же текстом плана.\n' +
    // Пункты 3 и 4 — единственный момент прогона, когда эти тулы вообще существуют:
    // весь цикл они скрыты гейтом. Просил человек файл или страницу — сделать это можно
    // только здесь, поэтому напоминание стоит именно тут, а не в промпте коуча.
    '3. Если человек просил отдельный файл — вызови write_file и положи план\n' +
    `   в plans/<дата>.md (сегодня ${new Date().toISOString().slice(0, 10)}). Только в plans/.\n` +
    '4. Если человек просил сохранить в Notion — найди страницу «Wellness» через\n' +
    '   API-post-search и создай страницу внутри неё через API-post-page.\n' +
    'Чего не просили — того не делай. Ничего не переписывай и не дополняй.\n' +
    'В ответ верни одну строку о том, что сохранил.'
  );
}

/**
 * Порог одобрения держит код. Промпт просит ревьюера не ставить approve ниже APPROVE_SCORE,
 * но просьба — не гарантия: модель, которой понравился план, ставит approve и при семи
 * баллах, а approve здесь открывает гейт и пишет файл. Замечаний при approve не бывает,
 * так что понижённому вердикту нужна хотя бы одна строка — иначе коуч получит «устрани
 * каждое замечание» с пустым списком.
 */
function enforceApproveThreshold(review: Review): Review {
  if (review.verdict !== 'approve' || review.score >= APPROVE_SCORE) return review;

  console.log(`   approve при score ${review.score} — ниже порога ${APPROVE_SCORE}, считаем revise`);
  const issues =
    review.issues.length > 0
      ? review.issues
      : [`Оценка ${review.score} из ${APPROVE_SCORE} нужных — усиль самые слабые места плана.`];

  return { ...review, verdict: 'revise', issues };
}

// ─── Цикл ─────────────────────────────────────────────────────────────────────

export async function runHealthAgent(
  task: string,
  {
    minRounds = DEFAULT_MIN_ROUNDS,
    maxRounds = DEFAULT_MAX_ROUNDS,
    onEvent,
    module,
    intentConfidence = 0,
  }: RunOptions = {},
): Promise<HealthAgentResult> {
  // Прогон без единого раунда нечем закончить: результата, по которому строится
  // вердикт и оценка, просто не появится.
  if (minRounds < 1) throw new Error('minRounds должен быть не меньше 1.');
  if (maxRounds < minRounds) throw new Error('maxRounds должен быть не меньше minRounds.');

  // Модуль — конфигурация, а не агент: он меняет промпт коуча и длину списка его тулов,
  // и ничего больше. Ревьюер, триаж, порог одобрения и порядок раундов про него не знают
  // и знать не должны — см. шапку src/os/modules/index.ts.
  const active = module ?? GENERAL;

  configureClient();

  const startedAt = Date.now();
  const promptVersions = activePromptVersions();

  // Гейт закрыт весь цикл: пока ревьюер не сказал approve, записать нельзя ни локальным
  // тулом (он вернёт отказ), ни MCP-шным (его просто не будет в списке). Владеет гейтом
  // харнесс — это политика прогона, и в промпте её держать нельзя (см. skills/gate.ts).
  //
  // Коуч собирается ниже, после триажа: ему нужен живой MCP-сервер, а поднимать процесс
  // ради задачи, которую триаж завернёт, незачем.
  const gate = createGate();
  // Журнал обращений к базе знаний — тоже на прогон и тоже во владении харнесса: тул
  // только пишет в него, читает результат сборка ниже. Форма та же, что у гейта,
  // и по той же причине — политика и данные прогона живут в коде харнесса.
  const retrievals = createRetrievalLog();
  // Третий объект той же формы и того же владения: рассказчик о ходе работы. Без
  // слушателя его send — пустая функция, поэтому ниже по коду нет ни одной проверки
  // «а следит ли кто-нибудь»: цикл читается одинаково для evals и для чата.
  const emitter = createEmitter(onEvent);
  const reviewer = createReviewer(loadPrompt('reviewer', promptVersions.reviewer));
  const triage = createTriage(loadPrompt('triage', promptVersions.triage));

  // Календарь считается один раз на прогон: раунды идут минутами, и дата за них
  // не меняется, а меняющийся под ногами календарь дал бы коучу и ревьюеру разные «сегодня».
  const calendar = calendarBlock();

  // Предпочтения кладёт харнесс, а не тул, — по той же причине, что и календарь: блок
  // короткий, всегда уместен, и решение «сходить ли за ним» коуч принимал бы каждый раз
  // заново. Ревьюеру он нужен не меньше: без него выбор, продиктованный записанным
  // предпочтением, выглядит выдумкой ровно настолько, насколько нечем проверить.
  const preferences = getPreferences(PREFERENCE_ENTRIES);

  // Ревьюер получает тот же календарь, и это обязательно: он проверяет план на выдумки,
  // а без своей даты не только пропустит неверный день недели, но и завернёт верный —
  // «19 августа среда» выглядит выдумкой ровно настолько, насколько нечем проверить.
  const reviewerContext =
    `${calendar}\n\n## Подтверждённые предпочтения\n${preferences}\n\n` +
    `## Профиль\n${getProfile()}\n\n## Дневник\n${getRecentLog(REVIEWER_LOG_DAYS)}\n\n## Задача\n${task}`;

  const askReviewer = async (input: string) =>
    String((await run(reviewer, input)).finalOutput ?? '');

  const rounds = createRoundLog();
  const toolCalls: string[] = [];
  // Заполняется при подключении серверов. До триажа их ещё нет, и пустая карта — честный
  // ответ: тулов не звали вовсе, потому что коуч не запускался.
  let toolSources: Record<string, string> = {};

  // Сборка результата в одном месте: сводки по раундам и время одинаковы на всех выходах.
  // Итоговый раунд передаётся явно — при доборе он не обязан быть последним.
  // Здесь же пишется трейс: через finish проходят оба выхода, и защитного контура тоже
  // касается — на диск уедет ровно то, что уехало наружу.
  const finish = (final: RoundState, history: RoundState[]): HealthAgentResult => {
    const result: HealthAgentResult = {
      plan: final.plan,
      review: final.review,
      rounds: history,
      finalRound: final.round,
      finalScore: final.review.score,
      improved: improvedAcrossRounds(history),
      toolCalls,
      toolSources,
      retrievals: retrievals.entries(),
      promptVersions,
      module: active.name,
      intentConfidence,
      durationMs: Date.now() - startedAt,
    };

    traceRun(task, result);
    return result;
  };

  // Триаж — первый контур, и он смотрит на задачу, а не на план. Решение «нужен живой
  // специалист» относится к запросу, поэтому и спрашивать его надо про запрос, отдельно
  // и до коуча: ревьюеру, который видит план, обелить запрос легко — грамотный отказ коуча
  // читается как хороший план, и ровно так был пропущен запрос про дозировки при болях
  // в груди (runs/run-2026-08-17T08-38-34-265Z.json). Здесь плана нет, обелять нечем.
  // Заодно такой прогон стоит одного похода в модель вместо целого цикла.
  const triaged = await triageTask(task, async (input) =>
    String((await run(triage, input)).finalOutput ?? ''),
  );
  emitter.send({ type: 'triage', blocked: triaged.blocked, reason: triaged.reason });

  if (triaged.blocked) {
    console.log(`Триаж: задача для живого специалиста, коуч не запускается. ${triaged.reason}`);
    // Раунд 0 — не раунд, а место в контракте: раундов не было, истории нет, плана нет.
    // Гейт так и не открывался, поэтому на диск за этот прогон не легло ничего.
    return finish({ round: 0, plan: null, review: humanProfessionalReview(triaged.reason) }, []);
  }

  // Дальше коучу нужны данные и инструменты, а они приезжают с MCP-серверов — отдельных
  // процессов. Поднимает и закрывает их харнесс, на прогон: живут они ровно столько,
  // сколько цикл, и закрываются в finally, иначе упавший прогон оставил бы висеть чужие
  // процессы. Какие именно серверы поднимутся, харнесс не знает и знать не должен — это
  // написано в src/mcp/servers.config.ts.
  // Сужение модулем. Только отнимает: предикат стоит ПОСЛЕ allowlist серверов, а не
  // вместо него, поэтому дать тул, которого нет в servers.config.ts, модулем нельзя.
  // Тулы записи выведены из-под сужения — ими командует только гейт.
  const allow = (name: string) =>
    WRITE_TOOLS.has(name) || active.tools === null || active.tools.includes(name);

  const mcp = await connectMcpServers(gate, allow);
  toolSources = mcp.toolSources;

  try {
    // Промпт коуча — база плюс наслойка модуля, а не подмена. Формат плана разбирают три
    // независимых парсера (app/plan-markdown.tsx, src/mcp/markdownBlocks.ts и sourceText
    // в src/skills/shopping.ts), и описан он должен быть один раз — иначе восемь модулей
    // дают восемь мест для тихого расхождения.
    const instructions =
      active.promptFile === null
        ? loadPrompt('coach', promptVersions.coach)
        : `${loadPrompt('coach', promptVersions.coach)}\n\n${loadModulePrompt(active.promptFile)}`;

    // Тулы коуча собираются здесь, а не в src/skills/: RAG — не навык работы с данными
    // человека, а другой источник и другая ответственность. Локальные фильтруются тем же
    // предикатом, что и MCP-шные: политика одна, исполняется в двух местах только потому,
    // что тулы живут в разных процессах.
    const coach = createCoach(
      instructions,
      [...localCoachTools(gate), createSearchKnowledgeTool(retrievals)].filter((skill) =>
        allow(skill.name),
      ),
      mcp.servers,
    );

    for (let round = 1; round <= maxRounds; round += 1) {
      const previous = rounds.last;
      // Три случая, и снаружи их по номеру раунда не различить: добор идёт после approve,
      // поэтому второй раунд бывает и «перепиши по замечаниям», и «усиль одобренное».
      // Тот же выбор, что делает buildCoachInput ниже, — только названный вслух.
      emitter.send({
        type: 'round-start',
        round,
        kind:
          previous === null ? 'first' : previous.review.verdict === 'approve' ? 'reinforce' : 'revise',
      });
      const coachOutput = await runCoach(coach, buildCoachInput(task, calendar, preferences, previous), {
        emitter,
        round,
        maxTurns: MAX_TURNS,
        toolSources,
      });
      // Тулы всех серверов приезжают сюда наравне с локальными: SDK превращает их
      // в обычные вызовы функций, и в трейсе openmeteo_get_forecast стоит рядом
      // с generateShoppingList. Для агента разницы между своим и чужим сервером нет.
      const roundCalls = collectToolCalls(coachOutput);
      toolCalls.push(...roundCalls);
      if (roundCalls.length > 0) {
        console.log(
          `   тулы: ${roundCalls.map((name) => `[${sourceOf(toolSources, name)}] ${name}`).join(', ')}`,
        );
      }
      const plan = String(coachOutput.finalOutput ?? '').trim();

      emitter.send({ type: 'review-start', round });
      const review = enforceApproveThreshold(
        await validateReview(buildReviewerInput(reviewerContext, plan, previous), askReviewer),
      );
      // После понижения порога, а не до: наружу должен уехать вердикт, который прогон
      // признал. Сказать «approve» там, где enforceApproveThreshold сделал revise,
      // значит показать одобрение, которое не открыло гейт и ничего не записало.
      emitter.send({ type: 'review-done', round, review });
      const state = rounds.record(plan, review);

      console.log(
        `Раунд ${round}/${maxRounds} (минимум ${minRounds}) · verdict: ${review.verdict} · score: ${review.score}`,
      );
      for (const issue of review.issues) console.log(`   - ${issue}`);

      if (review.verdict === 'needs_human_professional') {
        console.log('Это вне зоны велнеса — нужен живой специалист. План не сохранён.');
        // Защитный контур сильнее и минимума раундов, и прошлых одобрений: выходим сразу,
        // и плана нет ни в ответе, ни в истории раундов. Гейт так и остаётся закрытым,
        // поэтому на диск за этот прогон не легло ничего — ни план, ни список покупок.
        const blocked = redactPlans(rounds.history());
        return finish({ ...state, plan: null }, blocked);
      }

      if (review.verdict === 'approve') {
        // Одобрение закрывает цикл, только когда минимум пройден. Иначе идём ещё раунд:
        // коуч получит одобренный план на усиление, а наружу уедет лучший из одобренных.
        if (round >= minRounds) break;
        console.log(`Одобрено, но раундов пока ${round} из минимальных ${minRounds} — идём дальше.`);
      }
    }

    const history = rounds.history();
    const final = finalRound(history);
    // Цикл делает хотя бы один раунд (minRounds >= 1), так что итог всегда есть.
    if (final === null) throw new Error('Прогон закончился без единого раунда.');

    // Записываем один раз, на выходе, и ровно тот план, что уехал наружу: при доборе
    // одобренных раундов может быть несколько. Гейт открывается здесь и только здесь —
    // и вместе с ним в списке тулов коуча впервые появляется save_health_plan.
    if (final.review.verdict === 'approve' && final.plan !== null) {
      gate.unlock();
      // Закрепляющий заход тоже идёт через runCoach, и не ради текста — текста он не даёт.
      // Ради тулов: save_health_plan, generateShoppingList и write_file существуют только
      // здесь, весь цикл их прятал гейт. Не показать их значило бы умолчать ровно о том
      // моменте, когда план ложится на диск. round здесь null — заход вне цикла.
      emitter.send({ type: 'finalize' });
      const finalize = await runCoach(coach, buildFinalizeInput(task, final.plan), {
        emitter,
        round: null,
        maxTurns: MAX_TURNS,
        toolSources,
      });
      const finalizeCalls = collectToolCalls(finalize);
      toolCalls.push(...finalizeCalls);

      // Страховка, а не обход: гейт уже открыт, план уже одобрен — вопрос лишь в том, донесла
      // ли модель текст. Проверяем результат, а не факт вызова: коуч может позвать сохранение
      // и передать в него перепечатанный план — короче, приглаженный, без куска. Наружу
      // уехал final.plan, и в файле должен лежать он же, иначе человек читает одно, а на
      // диске другое. Пишем той же чистой функцией, что зовёт и сервер, — идти ради дописки
      // через MCP незачем. Молчать нельзя: в toolCalls дописки не появится, и трейс
      // не должен выглядеть так, будто агент справился сам.
      if (!planMatchesDisk(final.plan)) {
        savePlan(final.plan);
        console.log(
          finalizeCalls.includes(MCP_TOOLS.saveHealthPlan)
            ? 'Коуч сохранил не тот текст — план перезаписал харнесс.'
            : `Коуч не вызвал ${MCP_TOOLS.saveHealthPlan} в закрепляющем заходе — план записал харнесс.`,
        );
      }

      console.log(
        `План раунда ${final.round} из ${history.length} сохранён в data/output.md · score ${final.review.score}/10`,
      );
    } else {
      console.log(`Раундов было ${history.length}, одобрения нет. В data/output.md ничего не записано.`);
    }

    return finish(final, history);
  } finally {
    // Закрытие в finally, а не после return: выходов из блока три — обычный, защитный
    // контур и исключение, — а процессы серверов надо погасить на каждом.
    await mcp.close();
  }
}
