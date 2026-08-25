import { MCP_TOOLS } from '../../mcp/toolNames';
import { SEARCH_KNOWLEDGE } from '../../rag';
import { ALWAYS, type Module } from './types';

export const nutrition: Module = {
  name: 'nutrition',
  description:
    'Питание как режим: сколько белка, сколько приёмов пищи, что поменять в рационе, ' +
    'почему вечером тянет на сладкое. Про правила еды, а не про конкретное блюдо.',
  promptFile: 'nutrition.md',
  tools: [...ALWAYS, MCP_TOOLS.listRecipes, SEARCH_KNOWLEDGE],
};
