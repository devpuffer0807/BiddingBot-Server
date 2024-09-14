import { BigNumber, constants, Contract } from "ethers";

/**
 * Ensures the WETH allowance is sufficient.
 * @param wethContract - The WETH contract instance.
 * @param walletAddress - The wallet address.
 * @param offerPrice - The offer price.
 */
export async function ensureAllowance(wethContract: Contract, walletAddress: string, offerPrice: BigNumber, operator: string) {
  try {
    const allowance = await wethContract.allowance(walletAddress, operator);
    if (allowance.lt(offerPrice)) {
      console.log('Insufficient allowance! Approving Weth to Seaport Contract...');
      const tx = await wethContract.approve(operator, constants.MaxUint256);
      await tx.wait();
    }
  } catch (error: any) {
    console.error('Error ensuring allowance:', error?.reason ?? error?.message);
  }
}
