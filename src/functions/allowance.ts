import { BigNumber, constants, Contract } from "ethers";

const allowanceCache: { [key: string]: BigNumber } = {}; // Cache for allowances

/**
 * Ensures the WETH allowance is sufficient.
 * @param wethContract - The WETH contract instance.
 * @param walletAddress - The wallet address.
 * @param offerPrice - The offer price.
 */
export async function ensureAllowance(wethContract: Contract, walletAddress: string, offerPrice: BigNumber, operator: string) {
  try {
    const cacheKey = `${walletAddress}-${operator}`;

    // Check cache first
    if (allowanceCache[cacheKey]) {
      if (allowanceCache[cacheKey].lt(offerPrice)) {
        console.log('Insufficient allowance in cache! Approving Weth to Seaport Contract...');
        const tx = await wethContract.approve(operator, constants.MaxUint256);
        await tx.wait();
        allowanceCache[cacheKey] = constants.MaxUint256; // Update cache after approval
      }
      return; // Exit if using cached value
    }

    const allowance = await wethContract.allowance(walletAddress, operator);
    allowanceCache[cacheKey] = allowance; // Cache the fetched allowance

    if (allowance.lt(offerPrice)) {
      console.log('Insufficient allowance! Approving Weth to Seaport Contract...');
      const tx = await wethContract.approve(operator, constants.MaxUint256);
      await tx.wait();
      allowanceCache[cacheKey] = constants.MaxUint256; // Update cache after approval
    }
  } catch (error: any) {
    console.error('Error ensuring allowance:', error?.reason ?? error?.message);
  }
}
