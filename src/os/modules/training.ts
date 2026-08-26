import { LOCAL_TOOLS } from '../../skills/toolNames';
import { WEATHER_TOOLS } from '../../mcp/toolNames';
import { SEARCH_KNOWLEDGE } from '../../rag';
import { ALWAYS, type Module } from './types';

/**
 * Единственный модуль с погодой: только здесь план зависит от того, что на улице.
 * Рецепты отняты — тренировке они не нужны, а лишний тул в списке ухудшает выбор.
 */
export const training: Module = {
  name: 'training',
  description:
    'Тренировки и физическая активность: что делать в зале или дома, сколько подходов, ' +
    'как не нагружать больное место, куда пойти бегать. Слова-приметы: «тренировка», ' +
    '«зал», «пробежка», «упражнения».',
  promptFile: 'training.md',
  tools: [
    ...ALWAYS,
    LOCAL_TOOLS.suggestWorkoutTemplate,
    SEARCH_KNOWLEDGE,
    WEATHER_TOOLS.searchLocations,
    WEATHER_TOOLS.getForecast,
  ],
};
