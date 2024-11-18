import { ethers } from "ethers";
import { AxiosInstance } from 'axios';
import { Redis } from 'ioredis';
import { axiosInstance, limiter } from "../init";

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

class BalanceLockManager {
  private balanceLocks: Map<string, boolean>;
  private lockQueue: Set<string>;

  constructor() {
    this.balanceLocks = new Map();
    this.lockQueue = new Set();
  }

  private getLockKey(address: string, balanceType: BalanceType): string {
    return `${balanceType}_${address}`;
  }

  async acquireLock(address: string, balanceType: BalanceType): Promise<boolean> {
    const lockKey = this.getLockKey(address, balanceType);

    if (this.balanceLocks.get(lockKey)) {
      if (this.lockQueue.size >= MAX_QUEUE_SIZE) {
        return false;
      }
      this.lockQueue.add(lockKey);
      return false;
    }

    this.balanceLocks.set(lockKey, true);
    this.lockQueue.delete(lockKey);
    return true;
  }

  releaseLock(address: string, balanceType: BalanceType): void {
    const lockKey = this.getLockKey(address, balanceType);
    this.balanceLocks.delete(lockKey);
  }
}

class BalanceChecker {
  private deps: Dependencies;
  private lockManager: BalanceLockManager;

  constructor(deps: Dependencies) {
    this.deps = deps;
    this.lockManager = new BalanceLockManager();
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

    try {
      const cachedBalance = await this.getCachedBalance(cacheKey);

      if (!await this.lockManager.acquireLock(address, 'weth') && cachedBalance !== null) {
        return cachedBalance;
      }

      try {
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
        if (typeof responseData === 'string') {
          try {
            responseData = JSON.parse(responseData);
          } catch (e) {
            console.warn('Failed to parse string response:', e);
          }
        }

        const balance = this.extractBalanceFromResponse(responseData);
        if (balance === 0) {
          return 0;
        }
        await this.setCachedBalance(cacheKey, balance);
        return balance;
      } catch (error) {
        console.error("Error in WETH balance fetch:", error);
        return 0;
      } finally {
        this.lockManager.releaseLock(address, 'weth');
      }
    } catch (error) {
      this.lockManager.releaseLock(address, 'weth');
      console.error("Error fetching WETH balance:", error);
      return 0;
    }
  }

  private extractBalanceFromResponse(data: any): number {
    try {
      // Try different paths to find the balance
      if (data?.data?.wallet?.wrappedCurrencyFunds?.quantity) {
        return Number(data.data.wallet.wrappedCurrencyFunds.quantity);
      }
      // Add any other potential paths to find the balance here
      throw new Error('Balance not found in the response');
    } catch (e) {
      console.warn('Failed to extract balance from response:', e);
      throw e;
    }
  }

  async getBethBalance(address: string): Promise<number> {
    const cacheKey = `beth_balance:${address}`;

    try {
      const cachedBalance = await this.getCachedBalance(cacheKey);

      if (!await this.lockManager.acquireLock(address, 'beth') && cachedBalance !== null) {
        return cachedBalance;
      }

      try {
        const cachedBalanceAfterLock = await this.getCachedBalance(cacheKey);
        if (cachedBalanceAfterLock !== null) {
          return cachedBalanceAfterLock;
        }

        const wethContract = new ethers.Contract(
          BLUR_POOL_ADDRESS,
          ['function balanceOf(address) view returns (uint256)'],
          this.deps.provider
        );

        const balance = await wethContract.balanceOf(address);
        const formattedBalance = Number(ethers.utils.formatEther(balance));

        await this.setCachedBalance(cacheKey, formattedBalance);
        return formattedBalance;
      } finally {
        this.lockManager.releaseLock(address, 'beth');
      }
    } catch (error) {
      this.lockManager.releaseLock(address, 'beth');
      console.error("Error fetching BETH balance:", error);
      return 0;
    }
  }
}

// Usage example
export function createBalanceChecker(deps: Dependencies): BalanceChecker {
  return new BalanceChecker(deps);
}
