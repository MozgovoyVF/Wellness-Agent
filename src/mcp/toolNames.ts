// Имена тулов и URI ресурсов MCP-сервера. Отдельный модуль, потому что имена нужны в двух
// процессах сразу: сервер их регистрирует, а харнесс по ним фильтрует — какой тул коуч
// увидит, а какой нет (buildToolFilter в src/mcp/connectServers.ts). Разъедутся строки —
// гейт на запись молча перестанет держать, и это не заметит ни сборка, ни прогон.
//
// Импортировать их из markdownHealthServer.ts нельзя: тело того модуля поднимает stdio-
// транспорт, и харнесс, потянув константу, запустил бы сервер прямо в своём процессе.

/**
 * Тулы сервера. Значения — это то, что видит модель и что уезжает в toolCalls трейса.
 *
 * Из восьми коучу не даются два: append_daily_log и update_preferences. Оба пишут
 * в долгую память, и оба зовёт харнесс напрямую (src/os/memory.ts). Дневник — это
 * доказательная база ревьюера, и коуч, дописывающий туда во время планирования,
 * подделывает собственные доказательства; предпочтения — то, что подтвердил человек,
 * а не то, что решила модель.
 */
export const MCP_TOOLS = {
  readProfile: 'read_profile',
  readRecentLogs: 'read_recent_logs',
  appendDailyLog: 'append_daily_log',
  saveHealthPlan: 'save_health_plan',
  listRecipes: 'list_recipes',
  readHabits: 'read_habits',
  checkHabit: 'check_habit',
  updatePreferences: 'update_preferences',
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
 * Тулы чужого сервера weather, которые мы называем по имени. Имена придуманы не нами —
 * это то, что отдаёт @cyanheads/open-meteo-mcp-server; проверяются они единственным
 * способом: `npm run mcp:inspect` печатает список сервера целиком.
 *
 * Понадобились, когда те же строки пришлось назвать во втором месте: конфиг решает,
 * что достанется коучу, а модуль training — что достанется ему внутри модуля.
 */
export const WEATHER_TOOLS = {
  searchLocations: 'openmeteo_search_locations',
  getForecast: 'openmeteo_get_forecast',
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
  habits: 'habits://all',
  preferences: 'preferences://all',
} as const;
