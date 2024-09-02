import axios, { AxiosInstance } from "axios";
import axiosRetry, { IAxiosRetryConfig } from "axios-retry";
import limiter from "./limiter";

const axiosInstance: AxiosInstance = axios.create({
  timeout: 300000,
});

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
    }
    if (
      axiosRetry.isNetworkError(error) ||
      (error.response && error.response.status === 429)) {
      return true;
    }
    return false;
  },
};

axiosRetry(axiosInstance, retryConfig);

export default axiosInstance;