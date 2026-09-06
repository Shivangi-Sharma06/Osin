import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get('/health', async () => ({
    ok: true,
    service: 'osin-api',
    time: new Date().toISOString(),
  }));

  return app;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const app = await buildApp();
  try {
    await app.listen({ port: config.port, host: '127.0.0.1' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
