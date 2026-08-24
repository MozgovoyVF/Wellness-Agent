// MCP-сервер над markdown-файлами из data/. Отдельный процесс, транспорт stdio: харнесс
// поднимает его на прогон и закрывает после (src/mcp/healthMcp.ts).
//
// Почему сервер, а не как раньше — прямые функции в тулах агента. Раньше каждый источник
// данных подключался руками: написать функцию, обернуть её в tool(), вписать в массив,
// и всё это внутри одного приложения. Отдать те же данные второму агенту или чужому
// клиенту было нечем — интерфейса наружу не существовало. MCP — это как раз интерфейс:
// сервер объявляет тулы и ресурсы по стандарту, и подключиться к нему может кто угодно,
// от нашего коуча до MCP Inspector (`npm run mcp:inspect`).
//
// Границу держим строго: здесь только доступ к данным. Оценка, валидация ревью, порог
// одобрения и порядок раундов остаются в харнессе — сервер про прогон не знает ничего,
// в том числе про то, одобрен ли план. Гейт на запись живёт снаружи, на стороне клиента.
//
// Файлы сервер сам не читает: он зовёт те же чистые функции из src/skills/, что и до
// переезда. Так у data/ остаётся один способ доступа, а не два разошедшихся.

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { readData } from '../skills/dataFiles';
import { getProfile } from '../skills/profile';
import { appendDailyLog, getRecentLog, MAX_LOG_DAYS } from '../skills/logs';
import { listFavoriteRecipes } from '../skills/recipes';
import { savePlan } from '../skills/plans';
import { checkHabit, listHabits } from '../skills/habits';
import { appendPreference, getPreferences } from '../skills/preferences';
import { MCP_RESOURCES, MCP_TOOLS } from './toolNames';

// Сколько дней отдаёт ресурс logs://recent. У тула days спрашивается у вызывающего,
// а у ресурса параметров нет — URI фиксированный, значит окно приходится выбрать здесь.
const RESOURCE_LOG_DAYS = 7;

// Сколько записей отдаёт ресурс preferences://all. Причина та же, что у RESOURCE_LOG_DAYS:
// у тула окно спрашивается у вызывающего, а у ресурса параметров нет — URI фиксированный.
const RESOURCE_PREFERENCE_ENTRIES = 20;

const server = new McpServer({
  name: 'markdown-health',
  version: '1.0.0',
  title: 'Здоровье в markdown',
});

// ─── Тулы ─────────────────────────────────────────────────────────────────────
//
// Описания тулов — часть интерфейса модели, а не комментарий: по ним коуч решает, звать
// ли навык. Правишь описание — правишь поведение агента ровно так же, как правкой промпта.
// Тексты здесь те же, что стояли в tool() до переезда: переезд не должен был поменять
// поведение, и сравнивать прогоны «до» и «после» надо при одинаковых описаниях.

server.registerTool(
  MCP_TOOLS.readProfile,
  {
    title: 'Профиль человека',
    description:
      'Возвращает профиль человека целиком: возраст, вес, цели, ограничения по здоровью ' +
      '(непереносимости, травмы), условия готовки и тренировок, любимые и нелюбимые продукты. ' +
      'Вызывай его первым в любой задаче про питание, тренировки, сон или привычки: без профиля ' +
      'план нарушит ограничение, о котором ты не знаешь. Данных для ответа он не содержит только ' +
      'в одном случае — когда нужно, что человек делал в конкретные дни; для этого есть ' +
      `${MCP_TOOLS.readRecentLogs}.`,
    inputSchema: z.object({}),
  },
  async () => ({ content: [{ type: 'text', text: getProfile() }] }),
);

server.registerTool(
  MCP_TOOLS.readRecentLogs,
  {
    title: 'Дневник за последние дни',
    description:
      'Возвращает записи дневника за последние N дней: что человек ел и во сколько, как спал, ' +
      'тренировался ли, и его собственные заметки о самочувствии. Это единственный источник ' +
      'того, что происходило на самом деле, — профиль описывает намерения, дневник факты. ' +
      'Бери 2–3 дня для задачи про сегодня или завтра и 7 дней, когда нужно увидеть закономерность ' +
      `(накопился недосып, регулярно пропускается обед). Больше ${MAX_LOG_DAYS} дней в дневнике не хранится.`,
    inputSchema: z.object({
      days: z
        .number()
        .int()
        .min(1)
        .max(MAX_LOG_DAYS)
        .describe(`Сколько последних дней вернуть, от 1 до ${MAX_LOG_DAYS}. Если сомневаешься — 3.`),
    }),
  },
  async ({ days }) => ({ content: [{ type: 'text', text: getRecentLog(days) }] }),
);

server.registerTool(
  MCP_TOOLS.appendDailyLog,
  {
    title: 'Дописать запись в дневник',
    description:
      'Дописывает запись в конец data/log.md, ничего не затирая. Заголовок дня в формате ' +
      '«## 12 августа, вторник» передавай только тогда, когда этого дня в дневнике ещё нет: ' +
      'если день уже начат, запись без заголовка просто продолжит его, а второй такой же ' +
      'заголовок расколол бы один день надвое.',
    inputSchema: z.object({
      entry: z
        .string()
        .min(1)
        .describe('Markdown записи целиком, включая заголовок дня «## …».'),
    }),
  },
  async ({ entry }) => ({ content: [{ type: 'text', text: appendDailyLog(entry) }] }),
);

server.registerTool(
  MCP_TOOLS.saveHealthPlan,
  {
    title: 'Сохранить план',
    description:
      'Сохраняет итоговый план в data/output.md, перезаписывая прошлый. Передавай markdown ' +
      'плана целиком, ровно в том виде, в каком он должен достаться человеку, — без вступлений ' +
      'и без ограждений вокруг ответа.',
    inputSchema: z.object({
      markdown: z.string().min(1).describe('Полный markdown одобренного плана.'),
    }),
  },
  async ({ markdown }) => ({ content: [{ type: 'text', text: savePlan(markdown) }] }),
);

server.registerTool(
  MCP_TOOLS.listRecipes,
  {
    title: 'Любимые рецепты',
    description:
      'Возвращает список любимых рецептов человека: название, время приготовления, ингредиенты ' +
      'с граммовками и шаги. Все они уже проверены на ограничения из профиля. Вызывай, когда ' +
      'план включает приём пищи: взять блюдо отсюда надёжнее, чем придумать своё — придуманное ' +
      'человек может не приготовить. Если ничего подходящего в списке нет, предлагай своё, ' +
      'но с той же конкретностью: продукты, граммы, шаги.',
    inputSchema: z.object({}),
  },
  async () => ({ content: [{ type: 'text', text: listFavoriteRecipes() }] }),
);

server.registerTool(
  MCP_TOOLS.readHabits,
  {
    title: 'Привычки и отметки по дням',
    description:
      'Возвращает список привычек человека с отметками по дням: что отмечено выполненным, ' +
      'что пропущено, а про какие дни ничего не известно. Вызывай, когда задача про привычки, ' +
      'режим или регулярность: по отметкам видно, где привычка держится, а где рассыпалась, ' +
      'и это разные поводы для плана. Профиль говорит, чего человек хочет, дневник — что было, ' +
      'а этот список — что он сам считает нужным делать каждый день.',
    inputSchema: z.object({}),
  },
  async () => ({ content: [{ type: 'text', text: listHabits() }] }),
);

server.registerTool(
  MCP_TOOLS.checkHabit,
  {
    title: 'Отметить привычку выполненной',
    description:
      'Отмечает привычку выполненной за день. Вызывай только тогда, когда человек сам сказал, ' +
      `что сделал её, — это запись факта, а не части плана. Название бери из ${MCP_TOOLS.readHabits}: ` +
      'достаточно куска заголовка («зарядка»), но выдуманную привычку инструмент не заведёт ' +
      'и вернёт список имеющихся. Дата необязательна — без неё отмечается сегодняшний день.',
    inputSchema: z.object({
      habit: z
        .string()
        .min(1)
        .describe('Название привычки или его узнаваемая часть, как она стоит в списке привычек.'),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('День в формате 2026-08-24. Не передавай, если речь про сегодня.'),
    }),
  },
  // Дату по умолчанию считает сервер, а не модель: это то же правило, по которому день
  // недели считает calendarBlock(), — попутно посчитанная дата у модели уезжает.
  async ({ habit, date }) => ({
    content: [
      { type: 'text', text: checkHabit(habit, date ?? new Date().toISOString().slice(0, 10)) },
    ],
  }),
);

server.registerTool(
  MCP_TOOLS.updatePreferences,
  {
    title: 'Записать подтверждённое предпочтение',
    description:
      'Дописывает строку в data/preferences.md — долгую память о том, что человек подтвердил ' +
      'явно («запомни», «понравилось»). Этот инструмент коучу не даётся никогда: его зовёт ' +
      'харнесс после одобренного прогона. Он есть на сервере, потому что сервер — интерфейс ' +
      'к данным, а кто и когда имеет право писать, решает клиент.',
    inputSchema: z.object({
      entry: z
        .string()
        .min(1)
        .describe('Готовая строка записи целиком, начиная с «- » и с датой в формате 2026-08-24.'),
    }),
  },
  async ({ entry }) => ({ content: [{ type: 'text', text: appendPreference(entry) }] }),
);

// ─── Ресурсы ──────────────────────────────────────────────────────────────────
//
// Вторая половина протокола: не «сделай», а «вот данные по адресу». Агенту они не
// достаются — Agents SDK превращает в тулы только tools, а ресурс надо запросить явно.
// Здесь они ради Inspector и `npm run mcp:inspect`: показать сервер целиком.

const textResource = (uri: URL, text: string) => ({
  contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
});

server.registerResource(
  'profile',
  MCP_RESOURCES.profile,
  { title: 'Профиль', description: 'data/profile.md целиком.', mimeType: 'text/markdown' },
  async (uri) => textResource(uri, getProfile()),
);

server.registerResource(
  'recent-logs',
  MCP_RESOURCES.recentLogs,
  {
    title: 'Дневник, последние записи',
    description: `Последние ${RESOURCE_LOG_DAYS} дней из data/log.md.`,
    mimeType: 'text/markdown',
  },
  async (uri) => textResource(uri, getRecentLog(RESOURCE_LOG_DAYS)),
);

server.registerResource(
  'recipes',
  MCP_RESOURCES.recipes,
  { title: 'Рецепты', description: 'data/recipes.md целиком.', mimeType: 'text/markdown' },
  async (uri) => textResource(uri, listFavoriteRecipes()),
);

server.registerResource(
  'latest-plan',
  MCP_RESOURCES.latestPlan,
  {
    title: 'Последний сохранённый план',
    description: 'data/output.md — план последнего одобренного прогона.',
    mimeType: 'text/markdown',
  },
  // Файла может не быть: одобренного прогона ещё не случилось. Это не ошибка ресурса,
  // и падать здесь нельзя — иначе Inspector покажет сломанный сервер вместо пустого плана.
  async (uri) => {
    try {
      return textResource(uri, readData('output.md'));
    } catch {
      return textResource(uri, 'Плана пока нет: ни один прогон не дошёл до одобрения.');
    }
  },
);

server.registerResource(
  'habits',
  MCP_RESOURCES.habits,
  { title: 'Привычки', description: 'data/habits.md целиком.', mimeType: 'text/markdown' },
  async (uri) => textResource(uri, listHabits()),
);

server.registerResource(
  'preferences',
  MCP_RESOURCES.preferences,
  {
    title: 'Подтверждённые предпочтения',
    description: `Последние ${RESOURCE_PREFERENCE_ENTRIES} записей data/preferences.md.`,
    mimeType: 'text/markdown',
  },
  async (uri) => textResource(uri, getPreferences(RESOURCE_PREFERENCE_ENTRIES)),
);

// ─── Запуск ───────────────────────────────────────────────────────────────────
//
// stdout занят протоколом, поэтому писать в него нельзя ничего, кроме JSON-RPC: любой
// console.log сломает разбор на стороне клиента. Всё служебное — только в stderr.

await server.connect(new StdioServerTransport());
