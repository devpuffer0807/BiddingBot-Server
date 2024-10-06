import { BigNumber, ethers, utils, Wallet } from "ethers";
import { axiosInstance, limiter } from "../../init";
import redisClient from "../../utils/redis";
import { RESET } from "../..";
import { config } from "dotenv";

config()

const API_KEY = process.env.API_KEY as string;

const BLUR_API_URL = 'https://api.nfttools.website/blur';
const redis = redisClient.getClient();

const ALCHEMY_API_KEY = "HGWgCONolXMB2op5UjPH1YreDCwmSbvx"
const provider = new ethers.providers.AlchemyProvider('mainnet', ALCHEMY_API_KEY);
/**
 * Creates an offer on Blur.
 * @param walletAddress - The wallet address of the offerer.
 * @param privateKey - The private key of the offerer's wallet.
 * @param contractAddress - The contract address of the collection.
 * @param offerPrice - The price of the offer in wei.
 * @param traits - Optional traits for the offer.
 */
export async function bidOnBlur(
  wallet_address: string,
  private_key: string,
  contractAddress: string,
  offer_price: BigNumber | bigint,
  slug: string,
  expiry = 900,
  traits?: string
) {
  const offerPrice = BigNumber.from(offer_price.toString());
  const accessToken = await getAccessToken(BLUR_API_URL, private_key);

  const wallet = new Wallet(private_key, provider);

  const basePayload = {
    price: {
      unit: 'BETH',
      amount: utils.formatUnits(offerPrice),
    },
    quantity: 1,
    expirationTime: new Date(Date.now() + (expiry * 1000)).toISOString(),
    contractAddress: contractAddress,
  };

  const buildPayload = traits ? {
    ...basePayload,
    criteria: {
      type: "TRAIT",
      value: JSON.parse(traits)
    }
  } : basePayload;

  let build: any;
  try {
    if (!accessToken) {
      throw new Error('Access token is undefined');
    }
    build = await formatBidOnBlur(BLUR_API_URL, accessToken, wallet_address, buildPayload);

  } catch (error: any) {
    console.error('Error formatting bid on Blur:', error.message);
    return;
  }

  let data = build?.signatures?.[0];
  if (!data) {
    console.error(`Invalid response, retrying... SLUG: ${slug} TRAITS: ${traits}`);
    build = await formatBidOnBlur(BLUR_API_URL, accessToken, wallet_address, buildPayload); // Retry
    data = build?.signatures?.[0]; // Reassign data after retry
  }
  if (!data) {
    console.error('Invalid response after retry');
    return;
  }

  const signObj = await wallet._signTypedData(
    data?.signData?.domain,
    data?.signData?.types,
    data?.signData?.value
  );

  const submitPayload = {
    signature: signObj,
    marketplaceData: data?.marketplaceData,
  };

  try {
    const cancelPayload = {
      contractAddress,
      criteriaPrices: [
        {
          price: utils.formatUnits(offerPrice),
          criteria: {
            "type": traits ? "TRAIT" : "COLLECTION",
            value: traits ? JSON.parse(traits) : {}
          }
        }
      ]
    }

    await submitBidToBlur(BLUR_API_URL, accessToken, wallet_address, submitPayload, slug, cancelPayload, expiry, traits);

  } catch (error: any) {
    console.error("Error in bidOnBlur:", error.message);
  }
};

/**
 * Gets an access token.
 * @param url - The URL to get the access token from.
 * @param privateKey - The private key of the wallet.
 * @returns The access token.
 */
async function getAccessToken(url: string, private_key: string): Promise<string | undefined> {
  const wallet = new Wallet(private_key, provider);
  const options = { walletAddress: wallet.address };

  const headers = {
    'content-type': 'application/json',
    'X-NFT-API-Key': API_KEY
  };

  try {
    const key = `blur-access-token-${wallet.address}`
    const cachedToken = await redis.get(key);
    if (cachedToken) {
      return cachedToken;
    }
    let response: any = await limiter.schedule(() => axiosInstance
      .post(`${url}/auth/challenge`, options, { headers }));
    const message = response.data.message;
    const signature = await wallet.signMessage(message);
    const data = {
      message: message,
      walletAddress: wallet.address,
      expiresOn: response.data.expiresOn,
      hmac: response.data.hmac,
      signature: signature
    };
    response = await limiter.schedule(() => axiosInstance
      .post(`${url}/auth/login`, data, { headers }));
    const accessToken = response.data.accessToken;
    await redis.set(key, accessToken, 'EX', 2 * 60 * 60);
    return accessToken;
  } catch (error: any) {
    console.error("getAccessToken Error:", error.response?.data || error.message);
  }
};

/**
 * Sends a request to format a bid on Blur.
 * @param url - The URL to send the request to.
 * @param accessToken - The access token for authentication.
 * @param walletAddress - The wallet address of the offerer.
 * @param buildPayload - The payload for the bid.
 * @returns The formatted bid data.
 */
async function formatBidOnBlur(
  url: string,
  accessToken: string,
  walletAddress: string,
  buildPayload: any
) {
  try {
    const { data } = await limiter.schedule(() =>
      axiosInstance.request<BlurBidResponse>({
        method: 'POST',
        url: `${url}/v1/collection-bids/format`,
        headers: {
          'content-type': 'application/json',
          authToken: accessToken,
          walletAddress: walletAddress.toLowerCase(),
          'X-NFT-API-Key': API_KEY,
        },
        data: JSON.stringify(buildPayload),
      })
    );
    return data;
  } catch (error: any) {
    console.error("Error formatting bid " + `${JSON.stringify(buildPayload)}`, error.response?.data || error.message);
  }
}

/**
 * Submits a bid to Blur.
 * @param url - The URL to send the request to.
 * @param accessToken - The access token for authentication.
 * @param walletAddress - The wallet address of the offerer.
 * @param submitPayload - The payload for the bid submission.
 * @param slug - The slug of the collection.
 */
async function submitBidToBlur(
  url: string,
  accessToken: string,
  walletAddress: string,
  submitPayload: SubmitPayload,
  slug: string,
  cancelPayload: any,
  expiry = 900,
  traits?: string
) {
  try {
    const { data: offers } = await limiter.schedule(() =>
      axiosInstance.request({
        method: 'POST',
        url: `${url}/v1/collection-bids/submit`,
        headers: {
          'content-type': 'application/json',
          authToken: accessToken,
          walletAddress: walletAddress.toLowerCase(),
          'X-NFT-API-Key': API_KEY,
        },
        data: JSON.stringify(submitPayload),
      })
    );
    const successMessage = traits ? `🎉 TRAIT OFFER POSTED TO BLUR SUCCESSFULLY FOR: ${slug.toUpperCase()} 🎉 TRAIT: ${traits}` : `🎉 OFFER POSTED TO BLUR SUCCESSFULLY FOR: ${slug.toUpperCase()} 🎉`


    if (offers.errors) {
      console.error('Error:', JSON.stringify(offers.errors));
    } else {
      console.log("\x1b[33m", successMessage, RESET);
      const orderKey = traits
        ? `${JSON.stringify(traits)}`
        : "default"

      const key = `blur:order:${slug}:${orderKey}`;
      await redis.setex(key, expiry, JSON.stringify(cancelPayload));
    }
  } catch (error: any) {
    console.error("Error submitting bid:", error.response?.data || error.message);
  }
}

export async function cancelBlurBid(data: BlurCancelPayload) {
  try {
    const { payload, privateKey } = data
    const wallet = new Wallet(privateKey, provider);
    const walletAddress = wallet.address
    const accessToken = await getAccessToken(BLUR_API_URL, privateKey);
    const endpoint = `${BLUR_API_URL}/v1/collection-bids/cancel`
    const { data: cancelResponse } = await limiter.schedule(() => axiosInstance.post(endpoint, payload, {
      headers: {
        'content-type': 'application/json',
        authToken: accessToken,
        walletAddress: walletAddress.toLowerCase(),
        'X-NFT-API-Key': API_KEY,
      }
    }))
    console.log(JSON.stringify(cancelResponse));
  } catch (error) {
    console.log(error);
  }
}

export async function fetchBlurBid(collection: string, criteriaType: 'TRAIT' | 'COLLECTION', criteriaValue: Record<string, string>) {
  const url = `https://api.nfttools.website/blur/v1/collections/${collection}/executable-bids`;
  try {
    const { data } = await limiter.schedule(() => axiosInstance.get<BlurBidResponse>(url, {
      params: {
        filters: JSON.stringify({
          criteria: {
            type: criteriaType,
            value: criteriaValue
          }
        })
      },
      headers: {  // Moved headers into the same object
        'content-type': 'application/json',
        'X-NFT-API-Key': API_KEY,
      }
    }));

    console.log({ data: JSON.stringify(data), criteriaValue });

    return data;
  } catch (error: any) {
    console.error("Error fetching executable bids:", error.response?.data || error.message);
  }
}

interface PriceLevel {
  criteriaType: string;
  criteriaValue: Record<string, unknown>;
  price: string;
  executableSize: number;
  numberBidders: number;
  bidderAddressesSample: any[];
}

interface BlurBidResponse {
  success: boolean;
  priceLevels: PriceLevel[];
}

interface BlurCancelPayload {
  payload: {
    contractAddress: string;
    criteriaPrices: Array<{
      price: string;
      criteria?: {
        type: string;
        value: Record<string, string>;
      }
    }>;
  };
  privateKey: string;
}


interface Criteria {
  type: string;
  value: {
    [key: string]: string; // Adjust the type if you have specific keys
  };
}

interface CriteriaPrice {
  price: string;
  criteria: Criteria;
}

interface ICancelPayload {
  contractAddress: string;
  criteriaPrices: CriteriaPrice[];
}

interface BlurBidResponse {
  success: boolean;
  signatures: Signature[];
  [key: string]: any; // Allow additional properties

}

interface Signature {
  type: string;
  signData: SignData;
  marketplace: string;
  marketplaceData: string;
  tokens: any[];
  [key: string]: any; // Allow additional properties

}

interface SignData {
  domain: Domain;
  types: Types;
  value: Value;
  [key: string]: any; // Allow additional properties

}

interface Domain {
  name: string;
  version: string;
  chainId: string;
  verifyingContract: string;
  [key: string]: any; // Allow additional properties

}

interface Types {
  Order: OrderType[];
  FeeRate: FeeRateType[];
  [key: string]: any; // Allow additional properties

}
interface OrderType {
  name: string;
  type: string;
  [key: string]: any; // Allow additional properties

}

interface FeeRateType {
  name: string;
  type: string;
  [key: string]: any; // Allow additional properties

}

interface Value {
  trader: string;
  collection: string;
  listingsRoot: string;
  numberOfListings: number;
  expirationTime: string;
  assetType: number;
  makerFee: MakerFee;
  salt: string;
  orderType: number;
  nonce: Nonce;
  [key: string]: any; // Allow additional properties

}

interface MakerFee {
  recipient: string;
  rate: number;
  [key: string]: any; // Allow additional properties

}

interface Nonce {
  type: string;
  hex: string;
  [key: string]: any; // Allow additional properties

}

interface SubmitPayload {
  signature: string;
  marketplaceData: string[];
  [key: string]: any; // Allow additional properties
}
