import { MCP_TOOLS } from '../../mcp/toolNames';
import { SEARCH_KNOWLEDGE } from '../../rag';
import { ALWAYS, type Module } from './types';

/**
 * generateShoppingList в списке нет и быть не должно: это тул записи, он вне сужения
 * модулем и живёт под гейтом. В закрепляющем заходе он появится у любого модуля.
 */
export const shoppingList: Module = {
  name: 'shoppingList',
  description:
    'Закупка продуктов: что купить на неделю, список в магазин, сколько чего взять. ' +
    'Слова-приметы: «список покупок», «что купить», «в магазин».',
  promptFile: 'shoppingList.md',
  tools: [...ALWAYS, MCP_TOOLS.listRecipes, SEARCH_KNOWLEDGE],
};
