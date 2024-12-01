import { Redis } from 'ioredis';

export class DistributedLockManager {
  private redis: Redis;
  private readonly lockPrefix: string;
  private readonly defaultTTLSeconds: number;

  constructor(redis: Redis, options?: {
    lockPrefix?: string;
    defaultTTLSeconds?: number;
  }) {
    this.redis = redis;
    this.lockPrefix = options?.lockPrefix ?? 'lock:';
    this.defaultTTLSeconds = options?.defaultTTLSeconds ?? 30;
  }

  private getLockKey(key: string): string {
    return `${this.lockPrefix}${key}`;
  }

  async acquireLock(
    key: string,
    ttlSeconds: number = this.defaultTTLSeconds
  ): Promise<boolean> {
    const lockKey = this.getLockKey(key);

    const acquired = await this.redis.setex(
      lockKey,
      ttlSeconds,
      '1',
    );

    return acquired === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    const lockKey = this.getLockKey(key);
    await this.redis.del(lockKey);
  }

  async withLock<T>(
    key: string,
    operation: () => Promise<T>,
    ttlSeconds: number = this.defaultTTLSeconds
  ): Promise<T | null> {
    try {
      const acquired = await this.acquireLock(key, ttlSeconds);

      if (!acquired) {
        return null;
      }

      try {
        return await operation();
      } finally {
        await this.releaseLock(key);
      }
    } catch (error) {
      console.error(`Error in withLock for key ${key}:`, error);
      await this.releaseLock(key);
      throw error;
    }
  }
} 