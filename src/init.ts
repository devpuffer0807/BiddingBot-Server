import Bottleneck from "bottleneck";
import axios, { AxiosInstance } from "axios";
import axiosRetry, { IAxiosRetryConfig } from "axios-retry";

let limiter: Bottleneck;
let axiosInstance: AxiosInstance;
let API_KEY: string;
let RATE_LIMIT: number = 64;

async function fetchRateLimitFromDatabase() {
  return { rateLimit: 64, apiKey: "d3348c68-097d-48b5-b5f0-0313cc05e92d" };
}

const retryConfig: IAxiosRetryConfig = {
  retries: 3,
  retryDelay: (retryCount, error) => {
    limiter.schedule(() => Promise.resolve());
    if (error.response && error.response.status === 429) {
      return 1000;
    }
    return axiosRetry.exponentialDelay(retryCount);
  },
  retryCondition: async (error: any) => {
    if (error.response && error.response.status === 429) {
      return true;
    }
    if (
      axiosRetry.isNetworkError(error) ||
      (error.response && error.response.status === 429)) {
      return true;
    }
    return false;
  },
};

async function initialize() {
  axiosInstance = axios.create({
    timeout: 300000,
  });
  const { rateLimit, apiKey } = await fetchRateLimitFromDatabase();
  limiter = new Bottleneck({
    minTime: 1000 / rateLimit,
    priority: true // Enable priority queue
  });
  axiosRetry(axiosInstance, retryConfig);
  API_KEY = apiKey
  RATE_LIMIT = rateLimit
  console.log(`Limiter initialized with rate limit: ${rateLimit} requests per second`);
}

export { limiter, initialize, axiosInstance, API_KEY, RATE_LIMIT };