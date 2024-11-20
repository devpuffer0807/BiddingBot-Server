import { config } from 'dotenv';
import Redis from 'ioredis';

config()

const REDIS_URI = process.env.REDIS_URI as string

const getRedisUrl = () => {
  if (!REDIS_URI) {
    throw new Error('REDIS_URL is not defined in the environment variables');
  }
  return REDIS_URI;
}

const defaultConfig = {
  maxRetriesPerRequest: null,
  retryStrategy: (times: number) => {
    return Math.max(Math.min(Math.exp(times), 20000), 1000);
  }
};

class RedisClient {
  private static instance: RedisClient;
  private client: Redis | null = null;

  private constructor() {
    this.connect();
  }

  public static getInstance(): RedisClient {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient();
    }
    return RedisClient.instance;
  }

  private connect() {
    if (!this.client || !this.client) {
      this.client = new Redis(getRedisUrl(), defaultConfig);

      this.client.on('error', (err) => {
        console.error('Redis Client Error:', err);
      });

      this.client.on('connect', () => {
        console.log('Successfully connected to Redis');
      });
    }
  }

  public getClient(): Redis {
    if (!this.client) {
      this.connect();
    }
    return this.client!;
  }
}

const redisClient = RedisClient.getInstance();

export default redisClient;
