import { BigNumber, ethers, utils, Wallet } from "ethers";
import { API_KEY, axiosInstance, limiter } from "../../init";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY
const provider = new ethers.providers.AlchemyProvider('mainnet', ALCHEMY_API_KEY);
const BLUR_API_URL = 'https://api.nfttools.website/blur';
const EXPIRATION_TIME = 900000; // 15 minutes

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
    expirationTime: new Date(Date.now() + EXPIRATION_TIME).toISOString(),
    contractAddress: contractAddress,
  };

  const buildPayload = traits ? {
    ...basePayload,
    criteria: {
      type: "TRAIT",
      value: JSON.parse(traits)
    }
  } : basePayload;

  if (traits) {
    console.log('\x1b[32m%s\x1b[0m', '--------------------------------------------------------');
    console.log('\x1b[32m%s\x1b[0m', 'INITIATE BLUR TRAIT BIDDING.......');
    console.log('\x1b[32m%s\x1b[0m', '--------------------------------------------------------');
  }

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

  const data = build?.signatures?.[0];
  if (!data) {
    console.error('Invalid response');
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


    await submitBidToBlur(BLUR_API_URL, accessToken, wallet_address, submitPayload, slug);


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

    return response.data.accessToken;
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
): Promise<BlurBidResponse> {
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
    console.error("Error formatting bid:", error.response?.data || error.message);
    throw error;
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
  slug: string
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

    if (offers.errors) {
      console.error('Error:', JSON.stringify(offers.errors));
    } else {
      console.log(`🎉 OFFER POSTED TO BLUR SUCCESSFULLY FOR: ${slug.toUpperCase()} 🎉`);
    }
  } catch (error: any) {
    console.error("Error submitting bid:", error.response?.data || error.message);
  }
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