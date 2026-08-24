// Локальные инструменты коуча — те, что живут в этом же процессе и собираются через
// tool() из @openai/agents. Их осталось двое: остальное коуч берёт с MCP-сервера
// (src/mcp/markdownHealthServer.ts).
//
// Деление не случайное и оно же — главный предмет урока. В MCP уехало всё, что про
// **данные человека**: профиль, дневник, рецепты, сохранение плана. Локальными остались
// два навыка, где данных человека нет вовсе: шаблоны тренировок зашиты в код, а список
// покупок — разбор текста, который коуч только что написал сам. Стандартный сервер стоит
// заводить там, где есть чужой источник данных; ради чистой функции — незачем.
//
// Порядок в массиве — порядок в описании тулов для модели.

import { suggestWorkoutTemplateTool } from './workouts';
import { createGenerateShoppingListTool } from './shopping';
import type { Gate } from './gate';

export { createGate, type Gate, type GateControl } from './gate';
export { getProfile } from './profile';
export { getRecentLog, appendDailyLog, MAX_LOG_DAYS } from './logs';
export { listFavoriteRecipes } from './recipes';
export { savePlan, planMatchesDisk } from './plans';
export { LOCAL_TOOLS, LOCAL_WRITE_TOOLS } from './toolNames';

/**
 * Локальные тулы коуча. Гейт передаётся снаружи: харнесс владеет политикой «писать можно
 * только после approve», а навыки только спрашивают. У MCP-тулов та же политика
 * исполняется иначе — фильтром на стороне клиента, см. src/mcp/healthMcp.ts.
 *
 * Ревьюеру и триажу не даётся ни этот массив, ни MCP-сервер — см. src/agents/safetyReviewer.ts.
 */
export function localCoachTools(gate: Gate) {
  return [suggestWorkoutTemplateTool, createGenerateShoppingListTool(gate)];
}
