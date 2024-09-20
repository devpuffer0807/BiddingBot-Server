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
    if (!this.client) {
      this.client = new Redis({
        host: "localhost",
        port: 6379,
        maxRetriesPerRequest: null
      });
    }
    console.log("connected to redis");
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
