// Агент-коуч: пишет план. Оркестрация живёт не здесь, а в src/harness/runHealthAgent.ts.
// Текст промпта тоже не здесь: его версию выбирает и загружает харнесс.
// Тулы приходят снаружи по той же причине — что коучу доступно, решает харнесс.
//
// Источников тулов у коуча два, и для него самого разницы между ними нет: локальные
// приезжают массивом tools, MCP-шные Agents SDK сам вытянет из подключённых серверов
// и превратит в такие же функции. В трейсе они и выглядят одинаково.

import { Agent, type MCPServer, type Tool } from '@openai/agents';

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

export function createCoach(instructions: string, tools: Tool[], mcpServers: MCPServer[] = []) {
  return new Agent({
    name: 'Health Coach',
    instructions,
    model: MODEL,
    tools,
    mcpServers,
  });
}
