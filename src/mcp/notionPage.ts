// Сохранение плана в Notion по кнопке — то есть без агента и без модели.
//
// Тот же сервер, те же тулы, что достаются коучу, но зовём мы их сами: MCP-клиент умеет
// callTool напрямую, и модель для этого не нужна. Разница принципиальная, а не в скорости:
// у агента запись — это решение, которое он может принять неверно (перепечатать план
// своими словами, сохранить не туда), и весь гейт в этом проекте построен вокруг того,
// что решение принимает код. Кнопку жмёт человек, план уже одобрен и уже лежит на диске —
// решать нечего, надо выполнить. Поэтому здесь оркестрация в чистом виде: найти страницу,
// создать внутри неё дочернюю, закрыть процесс.
//
// Гейта здесь нет и быть не может: он живёт ровно столько, сколько прогон, а кнопку жмут
// после. Его роль играет сверка присланного плана с data/output.md — она стоит в роуте
// (app/api/plan/notion/route.ts), потому что это проверка запроса, а не работа с Notion.

import type { MCPServerStdio } from '@openai/agents';
import { connectMcpServer } from './connectServers';
import { toNotionBlocks } from './markdownBlocks';
import { NOTION_TOOLS } from './toolNames';

// Куда кладём. Название страницы, а не её id: id пришлось бы вписывать в .env и менять
// при каждом пересоздании страницы, а название человек и так знает — он сам его придумал,
// когда открывал интеграции доступ. Найти страницу по названию сервер умеет сам.
const PARENT_PAGE = 'Wellness';

// Год в заголовке не пишем: страницы лежат внутри Wellness по порядку, и «19 августа»
// читается лучше. Дата локальная — та же, что у календаря прогона.
const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });

/**
 * Что пошло не так, сказанное человеку. Отдельный класс, потому что роуту надо отличать
 * «не настроено или не найдено» от поломки: первое чинится руками в Notion за минуту,
 * и показывать вместо этого стек значит отправить человека искать ошибку в коде.
 */
export class NotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotionError';
  }
}

/** Текстовая часть ответа тула. У MCP ответ — массив частей, нам нужна первая текстовая. */
function textOf(result: unknown, tool: string): string {
  const parts = Array.isArray(result) ? result : [];

  for (const part of parts) {
    if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
      const { text } = part as { text?: unknown };
      if (typeof text === 'string') return text;
    }
  }

  throw new NotionError(`Тул ${tool} ответил без текста — сервер Notion повёл себя неожиданно.`);
}

/**
 * Зовёт тул и разбирает ответ. Ошибки Notion приезжают не исключением, а телом ответа:
 * сервер ловит HTTP-ошибку и отдаёт её как обычный результат с `status: "error"` внутри.
 * Не разобрать это здесь значит принять «интеграции не хватает прав» за успешный вызов
 * и сказать человеку, что план сохранён.
 */
async function call(
  server: MCPServerStdio,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const text = textOf(await server.callTool(tool, args), tool);

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new NotionError(`Тул ${tool} ответил не JSON: ${text.slice(0, 200)}`);
  }

  if (typeof data !== 'object' || data === null) {
    throw new NotionError(`Тул ${tool} ответил не объектом: ${text.slice(0, 200)}`);
  }

  const body = data as Record<string, unknown>;
  if (body.status === 'error' || body.object === 'error') {
    const message = typeof body.message === 'string' ? body.message : text.slice(0, 200);
    throw new NotionError(`Notion отказал (${tool}): ${message}`);
  }

  return body;
}

/** Название страницы Notion. Оно лежит в свойстве типа title, а как оно названо — не наше дело. */
function titleOf(page: Record<string, unknown>): string {
  const properties = page.properties;
  if (typeof properties !== 'object' || properties === null) return '';

  for (const property of Object.values(properties as Record<string, unknown>)) {
    if (typeof property !== 'object' || property === null) continue;
    const { type, title } = property as { type?: unknown; title?: unknown };
    if (type !== 'title' || !Array.isArray(title)) continue;

    return title
      .map((part) =>
        typeof part === 'object' && part !== null && typeof (part as { plain_text?: unknown }).plain_text === 'string'
          ? (part as { plain_text: string }).plain_text
          : '',
      )
      .join('');
  }

  return '';
}

/**
 * Ищет страницу-родителя. Поиск отдаёт только то, что расшарено интеграции, поэтому пустой
 * результат — это почти всегда забытый шаг «Connections» на самой странице, а не опечатка
 * в названии. Так и говорим: чинить человеку, а не гадать по стеку.
 */
async function findParent(server: MCPServerStdio): Promise<string> {
  const found = await call(server, NOTION_TOOLS.search, {
    query: PARENT_PAGE,
    filter: { value: 'page', property: 'object' },
    page_size: 20,
  });

  const results = Array.isArray(found.results) ? found.results : [];
  // Точное совпадение, а не первое попавшееся: поиск в Notion нечёткий и на «Wellness»
  // охотно отдаёт «Wellness archive» рядом. Класть план не в ту страницу хуже, чем не класть.
  const page = results.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === 'object' &&
      candidate !== null &&
      titleOf(candidate as Record<string, unknown>).trim().toLowerCase() === PARENT_PAGE.toLowerCase(),
  );

  if (page === undefined || typeof page.id !== 'string') {
    throw new NotionError(
      `Страница «${PARENT_PAGE}» не найдена. Создай её в Notion и открой интеграции доступ: ` +
        'на странице ⋯ → Connections → выбрать интеграцию.',
    );
  }

  return page.id;
}

/**
 * Кладёт план отдельной страницей внутрь «Wellness» и возвращает ссылку на неё.
 *
 * Сервер поднимается на одно это действие и гасится в finally: держать процесс между
 * нажатиями незачем, а незакрытый — это висящий npx на всё время жизни приложения.
 * Нет NOTION_TOKEN — сервера просто не будет, и это не поломка, а «не настроено»:
 * решает роут, как об этом сказать.
 */
export async function saveToNotion(markdown: string): Promise<{ url: string; title: string }> {
  const connection = await connectMcpServer('notion');
  if (connection === null) {
    throw new NotionError('Notion не подключён: в .env нет NOTION_TOKEN.');
  }

  const title = `План — ${dayMonth.format(new Date())}`;

  try {
    const created = await call(connection.server, NOTION_TOOLS.createPage, {
      parent: { page_id: await findParent(connection.server) },
      // Для страницы внутри страницы свойство ровно одно и называется title.
      properties: { title: { title: [{ text: { content: title } }] } },
      children: toNotionBlocks(markdown),
    });

    if (typeof created.url !== 'string') {
      throw new NotionError('Notion создал страницу, но не вернул ссылку на неё.');
    }

    return { url: created.url, title };
  } finally {
    await connection.close();
  }
}
