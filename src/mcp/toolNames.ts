// Имена тулов и URI ресурсов MCP-сервера. Отдельный модуль, потому что имена нужны в двух
// процессах сразу: сервер их регистрирует, а харнесс по ним фильтрует — какой тул коуч
// увидит, а какой нет (src/mcp/healthMcp.ts). Разъедутся строки — гейт на запись молча
// перестанет держать, и это не заметит ни сборка, ни прогон.
//
// Импортировать их из markdownHealthServer.ts нельзя: тело того модуля поднимает stdio-
// транспорт, и харнесс, потянув константу, запустил бы сервер прямо в своём процессе.

/** Тулы сервера. Значения — это то, что видит модель и что уезжает в toolCalls трейса. */
export const MCP_TOOLS = {
  readProfile: 'read_profile',
  readRecentLogs: 'read_recent_logs',
  appendDailyLog: 'append_daily_log',
  saveHealthPlan: 'save_health_plan',
  listRecipes: 'list_recipes',
} as const;

/**
 * Тулы чужого сервера notion, которые мы называем по имени. Имена придуманы не нами —
 * это то, что отдаёт @notionhq/notion-mcp-server, и проверяются они единственным способом:
 * `npm run mcp:inspect` печатает список сервера целиком.
 *
 * Константа появилась, когда те же строки понадобились во втором месте: конфиг решает,
 * что из них достанется коучу, а src/mcp/notionPage.ts зовёт две из них напрямую, мимо
 * агента. Две копии строки `API-post-page` разъехались бы молча — опечатка в конфиге
 * просто сняла бы тул с гейта, и не заметили бы этого ни сборка, ни прогон.
 *
 * Здесь их **три из четырёх**: `API-retrieve-a-page` стоит только в конфиге и больше
 * нигде не нужен.
 */
export const NOTION_TOOLS = {
  search: 'API-post-search',
  createPage: 'API-post-page',
  appendBlocks: 'API-patch-block-children',
} as const;

/**
 * Ресурсы сервера. Агенту они не достаются: Agents SDK превращает в тулы только tools,
 * а ресурсы читает лишь тот, кто явно позвал readResource. Здесь они ради MCP Inspector
 * и `npm run mcp:inspect` — показать, что у сервера есть и вторая половина протокола.
 */
export const MCP_RESOURCES = {
  profile: 'profile://me',
  recentLogs: 'logs://recent',
  recipes: 'recipes://all',
  latestPlan: 'plans://latest',
} as const;
