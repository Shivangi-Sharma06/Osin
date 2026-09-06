import type { Redis } from 'ioredis';
import { createRedisConnection } from './connection.js';

/**
 * Per-investigation progress events live in a Redis Stream
 * (osin:events:<id>) so SSE subscribers (Task 7) can catch up on history
 * and tail live updates without extra infrastructure.
 */
let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) publisher = createRedisConnection();
  return publisher;
}

export function eventsKey(investigationId: string): string {
  return `osin:events:${investigationId}`;
}

export type ProgressEventType =
  | 'started'
  | 'collector_started'
  | 'collector_completed'
  | 'collector_error'
  | 'scoring_started'
  | 'scoring_completed'
  | 'cluster_written'
  | 'completed'
  | 'failed';

export interface ProgressEvent {
  type: ProgressEventType;
  at: string;
  [key: string]: unknown;
}

export type ProgressEventInput = { type: ProgressEventType } & Record<string, unknown>;

export async function publishProgress(
  investigationId: string,
  event: ProgressEventInput,
): Promise<void> {
  const payload: ProgressEvent = { ...event, at: new Date().toISOString() } as ProgressEvent;
  try {
    await getPublisher().xadd(
      eventsKey(investigationId),
      'MAXLEN',
      '~',
      '200',
      '*',
      'data',
      JSON.stringify(payload),
    );
  } catch {
    // Progress streaming must never break the pipeline itself.
  }
}

// ---- Stream reading (Task 7 SSE) ----

export interface StreamEntry {
  id: string;
  event: ProgressEvent;
}

/**
 * Read progress events after `lastId`. Blocks up to `blockMs` when there is
 * nothing new — used by the SSE endpoint to tail live updates.
 */
export async function readEventsSince(
  investigationId: string,
  lastId: string,
  blockMs: number,
  reader?: Redis,
): Promise<StreamEntry[]> {
  const client = reader ?? getPublisher();
  const res = await client.xread(
    'BLOCK',
    blockMs,
    'STREAMS',
    eventsKey(investigationId),
    lastId,
  );
  if (!res) return [];
  const out: StreamEntry[] = [];
  for (const [, entries] of res) {
    for (const [entryId, fields] of entries) {
      const idx = fields.indexOf('data');
      if (idx === -1) continue;
      try {
        out.push({ id: entryId, event: JSON.parse(fields[idx + 1] ?? '{}') as ProgressEvent });
      } catch {
        // skip malformed entry
      }
    }
  }
  return out;
}
