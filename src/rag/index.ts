// Что видно снаружи слоя RAG. Внутрь папки никто не лазает: харнессу нужен тул и журнал,
// скрипту ингеста — chunks, эмбеддинги и запись в базу.

export { readKnowledgeChunks, embeddableText, type KnowledgeChunk } from './chunks';
export { embed, embeddingModel } from './embed';
export { replaceChunks, closePool, type StoredChunk, type KnowledgeMatch } from './store';
export { searchKnowledge, DEFAULT_TOP_K } from './retriever';
export { createRetrievalLog, type Retrieval, type RetrievalLog } from './retrievalLog';
export { createSearchKnowledgeTool, SEARCH_KNOWLEDGE } from './searchKnowledgeTool';
