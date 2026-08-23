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
import { MCP_RESOURCES, MCP_TOOLS } from './toolNames';

// Сколько дней отдаёт ресурс logs://recent. У тула days спрашивается у вызывающего,
// а у ресурса параметров нет — URI фиксированный, значит окно приходится выбрать здесь.
const RESOURCE_LOG_DAYS = 7;

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
      'Дописывает запись в конец data/log.md, ничего не затирая. Передавай готовый markdown ' +
      'записи вместе с заголовком дня в формате «## 12 августа, вторник» — формат дневника ' +
      'задаёт файл, и без заголовка запись сольётся с предыдущим днём.',
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

// ─── Запуск ───────────────────────────────────────────────────────────────────
//
// stdout занят протоколом, поэтому писать в него нельзя ничего, кроме JSON-RPC: любой
// console.log сломает разбор на стороне клиента. Всё служебное — только в stderr.

await server.connect(new StdioServerTransport());
