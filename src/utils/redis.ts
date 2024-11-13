import { config } from 'dotenv';
import Redis from 'ioredis';

config()

const REDIS_URI = process.env.REDIS_URI as string

const getRedisUrl = () => {
  if (!REDIS_URI) {
    throw new Error('REDIS_URL is not defined in the environment variables');
  }
  return REDIS_URI;
};

// Create two different Redis client configurations
const defaultConfig = {
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => {
    return Math.min(times * 50, 2000);
  }
};

const bullConfig = {
  maxRetriesPerRequest: null,
  retryStrategy: (times: number) => {
    return Math.min(times * 50, 2000);
  }
};

class RedisClient {
  private static instance: RedisClient;
  private client: Redis | null = null;
  private bullClient: Redis | null = null;

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
    if (!this.client || !this.bullClient) {
      this.client = new Redis(getRedisUrl(), defaultConfig);
      this.bullClient = new Redis(getRedisUrl(), bullConfig);

      // Set up error handlers for both clients
      [this.client, this.bullClient].forEach(client => {
        client.on('error', (err) => {
          console.error('Redis Client Error:', err);
        });

        client.on('connect', () => {
          console.log('Successfully connected to Redis');
        });
      });
    }
  }

  public getClient(): Redis {
    if (!this.client) {
      this.connect();
    }
    return this.client!;
  }

  public getBullClient(): Redis {
    if (!this.bullClient) {
      this.connect();
    }
    return this.bullClient!;
  }
}

const redisClient = RedisClient.getInstance();

export default redisClient;
