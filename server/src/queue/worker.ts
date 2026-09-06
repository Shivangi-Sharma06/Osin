import { Worker } from 'bullmq';
import { config } from '../config.js';
import { createRedisConnection } from './connection.js';
import { INVESTIGATION_QUEUE, type InvestigationJobData } from './queues.js';
import { runInvestigationPipeline } from '../services/pipeline.js';
import { pool } from '../db/pool.js';

const connection = createRedisConnection();

export const worker = new Worker<InvestigationJobData>(
  INVESTIGATION_QUEUE,
  async (job) => {
    console.log(`worker: processing investigation ${job.data.investigationId}`);
    await runInvestigationPipeline(job.data.investigationId);
    console.log(`worker: finished investigation ${job.data.investigationId}`);
  },
  { connection, concurrency: 2 },
);

worker.on('failed', (job, err) => {
  console.error(`worker: job ${job?.id ?? '?'} failed: ${err.message}`);
});

worker.on('error', (err) => {
  console.error(`worker: error: ${err.message}`);
});

async function shutdown(): Promise<void> {
  console.log('worker: shutting down...');
  await worker.close();
  connection.disconnect();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

console.log(`worker: ready on queue "${INVESTIGATION_QUEUE}" (concurrency 2, redis=${config.redisUrl})`);
