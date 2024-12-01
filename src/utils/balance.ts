import { ethers } from "ethers";
import { Redis } from 'ioredis';
import { axiosInstance, limiter } from "../init";
import { DistributedLockManager } from './lock';

// Constants
const CACHE_EXPIRY_SECONDS = 60;
const MAX_QUEUE_SIZE = 64;
const BLUR_POOL_ADDRESS = "0x0000000000A39bb272e79075ade125fd351887Ac";

// Environment configuration
const config = {
  API_KEY: process.env.API_KEY,
  ALCHEMY_KEY: process.env.ALCHEMY_KEY,
  OPENSEA_API_URL: 'https://api.nfttools.website/opensea/__api/graphql/',
};

// Type Definitions
type BalanceType = 'weth' | 'beth';

interface Dependencies {
  redis: Redis;
  provider: ethers.providers.Provider;
}

class BalanceChecker {
  private deps: Dependencies;
  private lockManager: DistributedLockManager;

  constructor(deps: Dependencies) {
    this.deps = deps;
    this.lockManager = new DistributedLockManager(deps.redis, {
      lockPrefix: 'balance_lock:',
      defaultTTLSeconds: CACHE_EXPIRY_SECONDS
    });
  }

  private async getCachedBalance(cacheKey: string): Promise<number | null> {
    try {
      const cachedBalance = await this.deps.redis.get(cacheKey);
      return cachedBalance ? Number(cachedBalance) : null;
    } catch (error) {
      console.error('Redis cache error:', error);
      return null;
    }
  }

  private async setCachedBalance(cacheKey: string, balance: number): Promise<void> {
    try {
      await this.deps.redis.set(
        cacheKey,
        balance.toString(),
        'EX',
        CACHE_EXPIRY_SECONDS
      );
    } catch (error) {
      console.error('Redis cache set error:', error);
    }
  }

  async getWethBalance(address: string): Promise<number> {
    const cacheKey = `weth_balance:${address}`;
    let cachedBalance = await this.getCachedBalance(cacheKey);

    const result = await this.lockManager.withLock(
      `weth_${address}`,
      async () => {
        // Check cache again after acquiring lock
        const cachedBalanceAfterLock = await this.getCachedBalance(cacheKey);
        if (cachedBalanceAfterLock !== null) {
          return cachedBalanceAfterLock;
        }

        const payload = {
          id: "WalletPopoverDataPollerClosedQuery",
          query: "query WalletPopoverDataPollerClosedQuery(\n  $address: AddressScalar!\n  $wrappedCurrencySymbol: String!\n  $wrappedCurrencyChain: ChainScalar!\n) {\n  ...WalletAndAccountButtonFundsDisplay_data_p0g3U\n}\n\nfragment FundsDisplay_walletFunds on WalletFundsType {\n  symbol\n  quantity\n}\n\nfragment WalletAndAccountButtonFundsDisplay_data_p0g3U on Query {\n  wallet(address: $address) {\n    wrappedCurrencyFunds: fundsOf(symbol: $wrappedCurrencySymbol, chain: $wrappedCurrencyChain) {\n      quantity\n      symbol\n      ...FundsDisplay_walletFunds\n      id\n    }\n  }\n}\n",
          variables: {
            address,
            wrappedCurrencySymbol: "WETH",
            wrappedCurrencyChain: "ETHEREUM"
          }
        };

        // Retry logic with exponential backoff
        const maxRetries = 3;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const response = await limiter.schedule(() =>
              axiosInstance.post(
                config.OPENSEA_API_URL,
                payload,
                {
                  headers: {
                    'x-nft-api-key': config.API_KEY,
                    'x-auth-address': address,
                    'x-signed-query': "51ab975e49c64eae0c01857a6fa0f29a3844856bfd4bbe3375321f6bcc4fdfac",
                  },
                }
              )
            );

            let responseData = response.data;
            if (!responseData || typeof responseData !== 'object') {
              console.warn('Invalid response data format:', responseData);
              return cachedBalance ?? 0;
            }

            const balance = this.extractBalanceFromResponse(responseData, cachedBalance);
            await this.setCachedBalance(cacheKey, balance);
            return balance;
          } catch (error) {
            if (attempt === maxRetries) {
              console.error("Error in WETH balance fetch after retries:", error);
              return cachedBalance ?? 0;
            }
            const backoffTime = Math.pow(2, attempt) * 100; // Exponential backoff
            await new Promise(resolve => setTimeout(resolve, backoffTime));
          }
        }
      }
    );

    return result ?? (cachedBalance ?? 0);
  }

  private extractBalanceFromResponse(data: any, cachedBalance: number | null = 0): number {
    if (!data?.data?.wallet?.wrappedCurrencyFunds?.quantity) {
      console.warn('Unexpected response structure:', data);
      return cachedBalance ?? 0;
    }

    const balance = Number(data.data.wallet.wrappedCurrencyFunds.quantity);
    if (isNaN(balance)) {
      console.warn('Invalid balance value:', data.data.wallet.wrappedCurrencyFunds.quantity);
      return cachedBalance ?? 0;
    }

    return balance;
  }

  async getBethBalance(address: string): Promise<number> {
    const cacheKey = `beth_balance:${address}`;
    let cachedBalance = await this.getCachedBalance(cacheKey);

    const result = await this.lockManager.withLock(
      `beth_${address}`,
      async () => {
        // Check cache again after acquiring lock
        const cachedBalanceAfterLock = await this.getCachedBalance(cacheKey);
        if (cachedBalanceAfterLock !== null) {
          return cachedBalanceAfterLock;
        }

        const wethContract = new ethers.Contract(
          BLUR_POOL_ADDRESS,
          ['function balanceOf(address) view returns (uint256)'],
          this.deps.provider
        );

        // Retry logic with exponential backoff
        const maxRetries = 3;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const balance = await wethContract.balanceOf(address);
            const formattedBalance = Number(ethers.utils.formatEther(balance));

            await this.setCachedBalance(cacheKey, formattedBalance);
            return formattedBalance;
          } catch (error) {
            if (attempt === maxRetries) {
              console.error("Error fetching BETH balance after retries:", error);
              return cachedBalance ?? 0;
            }
            const backoffTime = Math.pow(2, attempt) * 100; // Exponential backoff
            await new Promise(resolve => setTimeout(resolve, backoffTime));
          }
        }
      }
    );

    return result ?? (cachedBalance ?? 0);
  }
}

// Usage example
export function createBalanceChecker(deps: Dependencies): BalanceChecker {
  return new BalanceChecker(deps);
}
