import { MCP_TOOLS } from '../../mcp/toolNames';
import { SEARCH_KNOWLEDGE } from '../../rag';
import { ALWAYS, type Module } from './types';

/**
 * Явно перечисляет тулы привычек — но не единственный модуль, которому они достаются.
 * Модули с tools: null (general, dailyPlan) ничего не сужают, и allow() пропускает всё,
 * что разрешает конфиг сервера, — включая read_habits и check_habit. Гейта у check_habit
 * при этом нет нигде — причина записана в src/mcp/servers.config.ts рядом со строкой:
 * отметка привычки это факт, который человек сообщил в запросе, а не запись плана.
 */
export const habits: Module = {
  name: 'habits',
  description:
    'Привычки и регулярность: отметить сделанное, посмотреть, что держится, а что ' +
    'рассыпалось, завести режим и удержать его. Слова-приметы: «привычка», «отметь», ' +
    '«каждый день», «серия», «не срываться».',
  promptFile: 'habits.md',
  tools: [...ALWAYS, MCP_TOOLS.readHabits, MCP_TOOLS.checkHabit, SEARCH_KNOWLEDGE],
};
