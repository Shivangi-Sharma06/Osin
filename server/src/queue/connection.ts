import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * Shared ioredis factory. BullMQ requires maxRetriesPerRequest: null so
 * blocking commands never bail out mid-wait.
 */
export function createRedisConnection(): Redis {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}
