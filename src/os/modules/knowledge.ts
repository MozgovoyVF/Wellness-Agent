import { SEARCH_KNOWLEDGE } from '../../rag';
import { ALWAYS, type Module } from './types';

export const knowledge: Module = {
  name: 'knowledge',
  description:
    'Вопрос про то, как устроено: зачем белок, почему поздний ужин мешает сну, что ' +
    'такое зона пульса. Человек спрашивает объяснение, а не план на завтра.',
  promptFile: 'knowledge.md',
  tools: [...ALWAYS, SEARCH_KNOWLEDGE],
};
