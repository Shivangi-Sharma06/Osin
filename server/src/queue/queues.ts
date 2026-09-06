import { Queue } from 'bullmq';
import { createRedisConnection } from './connection.js';

export const INVESTIGATION_QUEUE = 'investigations';

export interface InvestigationJobData {
  investigationId: string;
}

let queue: Queue<InvestigationJobData> | null = null;

export function getInvestigationQueue(): Queue<InvestigationJobData> {
  if (!queue) {
    queue = new Queue<InvestigationJobData>(INVESTIGATION_QUEUE, {
      connection: createRedisConnection(),
    });
  }
  return queue;
}

/** Fire-and-forget enqueue — the API never blocks on collector work. */
export async function enqueueInvestigation(investigationId: string): Promise<void> {
  await getInvestigationQueue().add(
    'run',
    { investigationId },
    {
      jobId: investigationId, // BullMQ forbids ':' in custom ids — use the raw uuid
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  );
}
