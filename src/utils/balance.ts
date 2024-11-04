import { ethers } from "ethers";
const ALCHEMY_API_KEY = "0rk2kbu11E5PDyaUqX1JjrNKwG7s4ty5";
const provider = new ethers.providers.AlchemyProvider("mainnet", ALCHEMY_API_KEY)

export async function getEthBalance(address: string): Promise<number> {
  try {
    // const provider = new ethers.providers.JsonRpcProvider('https://eth.drpc.org');
    const balance = await provider.getBalance(address);
    return Number(ethers.utils.formatEther(balance));
  } catch (error) {
    console.error("Error fetching ETH balance:", error);
    // throw error; // Rethrow the error after logging
    return 0
  }
}

export async function getWethBalance(address: string): Promise<number> {
  try {
    const WETH_CONTRACT_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    // const provider = new ethers.providers.JsonRpcProvider('https://eth.drpc.org');
    const wethContract = new ethers.Contract(WETH_CONTRACT_ADDRESS, ['function balanceOf(address) view returns (uint256)'], provider);
    const balance = await wethContract.balanceOf(address);
    return Number(ethers.utils.formatEther(balance));
  } catch (error) {
    console.error("Error fetching WETH balance:", error);
    return 0

    // throw error; // Rethrow the error after logging
  }
}

export async function getBethBalance(address: string): Promise<number> {
  try {
    const BLUR_POOL_ADDRESS = "0x0000000000A39bb272e79075ade125fd351887Ac";
    const wethContract = new ethers.Contract(BLUR_POOL_ADDRESS, ['function balanceOf(address) view returns (uint256)'], provider);
    const balance = await wethContract.balanceOf(address);
    return Number(ethers.utils.formatEther(balance));
  } catch (error) {
    console.error("Error fetching BETH balance:", error);
    return 0
    // throw error; // Rethrow the error after logging
  }
}