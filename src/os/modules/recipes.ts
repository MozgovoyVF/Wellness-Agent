import { MCP_TOOLS } from '../../mcp/toolNames';
import { SEARCH_KNOWLEDGE } from '../../rag';
import { ALWAYS, type Module } from './types';

export const recipes: Module = {
  name: 'recipes',
  description:
    'Что конкретно приготовить и съесть: блюдо на приём пищи, замена блюду, обед ' +
    'в контейнер. Слова-приметы: «что приготовить», «на ужин», «рецепт».',
  promptFile: 'recipes.md',
  tools: [...ALWAYS, MCP_TOOLS.listRecipes, SEARCH_KNOWLEDGE],
};
