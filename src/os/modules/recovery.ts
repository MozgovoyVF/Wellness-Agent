import { MCP_TOOLS } from '../../mcp/toolNames';
import { LOCAL_TOOLS } from '../../skills/toolNames';
import { SEARCH_KNOWLEDGE } from '../../rag';
import { ALWAYS, type Module } from './types';

/**
 * Восстановление почти всегда задевает еду и мягкую активность — «нет сил» решается
 * не только сном, но и тем, что и сколько есть, и какая нагрузка ещё посильна. Поэтому
 * рецепты и шаблоны тренировок здесь остаются, в отличие от узких nutrition/training.
 * Отнята только погода: план восстановления не строится вокруг того, что на улице.
 */
export const recovery: Module = {
  name: 'recovery',
  description:
    'Восстановление: сон, отдых, усталость, перетренированность, боль и дискомфорт ' +
    'после нагрузки. Слова-приметы: «нет сил», «не высыпаюсь», «болит после тренировки», ' +
    '«как восстановиться».',
  promptFile: 'recovery.md',
  tools: [...ALWAYS, MCP_TOOLS.listRecipes, LOCAL_TOOLS.suggestWorkoutTemplate, SEARCH_KNOWLEDGE],
};
