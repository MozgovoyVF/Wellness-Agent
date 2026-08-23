import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Оба пакета тянут node-специфику — пусть грузятся нативным require, а не через бандл.
  // У `pg` это отложенный require необязательного `pg-native`: бандлер видит его как
  // недостающий модуль и ломает драйвер на первом же запросе, хотя сборка проходит.
  serverExternalPackages: ['@openai/agents', 'pg'],
};

export default nextConfig;
