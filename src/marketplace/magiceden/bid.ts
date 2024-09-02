import { BigNumber, Contract, ethers, Wallet } from "ethers";
import { API_KEY, axiosInstance, limiter } from "../../init";
import { MAGICEDEN_CONTRACT_ADDRESS, WETH_CONTRACT_ADDRESS, WETH_MIN_ABI } from "../../constants";
import { config } from "dotenv";
import { ensureAllowance } from "../../functions";

config()
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY
const provider = new ethers.providers.AlchemyProvider('mainnet', ALCHEMY_API_KEY);

/**
 * Places a bid on Magic Eden.
 * @param maker - The maker of the bid.
 * @param collection - The collection to bid on.
 * @param quantity - The quantity to bid.
 * @param weiPrice - The price in wei.
 * @param expirationTime - The expiration time of the bid.
 * @param privateKey - The private key of the maker's wallet.
 * @param slug - Collection slug
 */


export async function bidOnMagiceden(
  maker: string,
  collection: string,
  quantity: number,
  weiPrice: string,
  expirationTime: string,
  privateKey: string,
  slug: string
) {

  const wallet = new Wallet(privateKey, provider);
  const wethContract = new Contract(WETH_CONTRACT_ADDRESS,
    WETH_MIN_ABI, wallet);

  const offerPrice = BigNumber.from(weiPrice);
  await ensureAllowance(wethContract, wallet.address, offerPrice, MAGICEDEN_CONTRACT_ADDRESS);

  try {
    const order = await createBidData(maker, collection, quantity, weiPrice, expirationTime);

    const wallet = new Wallet(privateKey, provider);

    if (order) {
      const res = await submitSignedOrderData(order, wallet, slug)
      return res
    }
    return order
  } catch (error: any) {
    console.log(error.response.data);

  }
}

/**
 * Signs the order data.
 * @param wallet - The wallet of the offerer.
 * @param signData - The data to be signed.
 * @returns The signature.
 */
async function signOrderData(wallet: ethers.Wallet, signData: any): Promise<string> {
  try {
    const signature = await wallet._signTypedData(
      signData.domain,
      signData.types,
      signData.value
    );
    return signature;
  } catch (error: any) {
    console.error('Error signing data:', error.message);
    throw error;
  }
}

/**
 * Sends the signed order data to the API.
 * @param signature - The signature of the order data.
 * @param data - The order data.
 * @param slug - Collection slug
 * @returns The response from the API.
 */
async function sendSignedOrderData(signature: string, data: SignedData, slug: string) {
  const signEndpoint = "https://api.nfttools.website/magiceden/v3/rtp/ethereum/order/v4";

  try {
    const { data: offerResponse } = await limiter.schedule(() =>
      axiosInstance.post(
        `${signEndpoint}?signature=${encodeURIComponent(signature)}`,
        data,
        {
          headers: {
            'content-type': 'application/json',
            'X-NFT-API-Key': API_KEY,
          }
        }
      )
    );

    console.log(`🎉 OFFER POSTED TO MAGICEDEN SUCCESSFULLY FOR: ${slug.toUpperCase()} 🎉`);

    return offerResponse;
  } catch (axiosError: any) {
    if (axiosError.response) {
      // Server responded with a status other than 2xx
      console.error('Error response from server:', axiosError.response.data);
    } else if (axiosError.request) {
      // Request was made but no response received
      console.error('No response received:', axiosError.request);
    } else {
      // Something else happened while setting up the request
      console.error('Error setting up request:', axiosError.message);
    }
    throw axiosError;
  }
}

/**
 * Submits signed order data.
 * @param order - The order data.
 * @param wallet - The wallet of the offerer.
 * @param slug - Collection slug

 */
export async function submitSignedOrderData(order: CreateBidData, wallet: ethers.Wallet, slug: string) {
  const signData = order?.steps
    ?.find((step) => step.id === "order-signature")
    ?.items?.[0]?.data?.sign;

  if (signData) {
    try {
      const signature = await signOrderData(wallet, signData);
      const payload = signData.value;
      const { buyer, ...rest } = payload;

      const data = {
        items: [
          {
            order: {
              kind: "payment-processor-v2",
              data: {
                kind: "collection-offer-approval",
                sellerOrBuyer: buyer,
                ...rest,
                r: "0x0000000000000000000000000000000000000000000000000000000000000000",
                s: "0x0000000000000000000000000000000000000000000000000000000000000000",
                v: 0,
              },
            },
            orderbook: "reservoir",
          },
        ],
        source: "magiceden.io",
      };

      return await sendSignedOrderData(signature, data, slug);
    } catch (error: any) {
      console.error('Error in submitSignedOrderData:', error.message);
    }
  } else {
    console.error('Sign data not found in order steps.');
  }
}

/**
 * Creates bid data for Magic Eden.
 * @param maker - The maker of the bid.
 * @param collection - The collection to bid on.
 * @param quantity - The quantity to bid.
 * @param weiPrice - The price in wei.
 * @param expirationTime - The expiration time of the bid.
 * @returns The bid data.
 */
async function createBidData(
  maker: string,
  collection: string,
  quantity: number,
  weiPrice: string,
  expirationTime: string
) {
  const data = {
    maker: maker,
    source: "magiceden.io",
    params: [
      {
        collection: collection,
        currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        quantity: quantity,
        weiPrice: weiPrice,
        expirationTime: expirationTime,
        orderKind: "payment-processor-v2",
        orderbook: "reservoir",
        options: {
          "payment-processor-v2": {
            useOffChainCancellation: true
          }
        },
        automatedRoyalties: true
      }
    ]
  };

  const { data: order } = await limiter.schedule(() => axiosInstance.post<CreateBidData>('https://api.nfttools.website/magiceden/v3/rtp/ethereum/execute/bid/v5', data, {
    headers: {
      'content-type': 'application/json',
      'X-NFT-API-Key': API_KEY
    }
  }));

  return order;
}

interface StepItem {
  status?: string;
  orderIndexes?: number[];
  data?: {
    sign: {
      signatureKind: string;
      domain: {
        name: string;
        version: string;
        chainId: number;
        verifyingContract: string;
      };
      types: {
        CollectionOfferApproval: {
          name: string;
          type: string;
        }[];
      };
      value: {
        protocol: number;
        cosigner: string;
        buyer: string;
        beneficiary: string;
        marketplace: string;
        fallbackRoyaltyRecipient: string;
        paymentMethod: string;
        tokenAddress: string;
        amount: string;
        itemPrice: string;
        expiration: string;
        marketplaceFeeNumerator: string;
        nonce: string;
        masterNonce: string;
      };
      primaryType: string;
    };
    post: {
      endpoint: string;
      method: string;
      body: {
        items: {
          order: {
            kind: string;
            data: {
              kind: string;
              protocol: number;
              cosigner: string;
              sellerOrBuyer: string;
              marketplace: string;
              paymentMethod: string;
              tokenAddress: string;
              amount: string;
              itemPrice: string;
              expiration: string;
              marketplaceFeeNumerator: string;
              nonce: string;
              masterNonce: string;
              fallbackRoyaltyRecipient: string;
              beneficiary: string;
              v: number;
              r: string;
              s: string;
            };
          };
          collection: string;
          isNonFlagged: boolean;
          orderbook: string;
        }[];
        source: string;
      };
    };
  };
  [key: string]: any; // Allow additional properties
}

interface Step {
  id: string;
  action: string;
  description: string;
  kind: string;
  items: StepItem[];
  [key: string]: any; // Allow additional properties

}

interface CreateBidData {
  steps: Step[];
  errors: any[];
  [key: string]: any; // Allow additional properties

}

interface OrderData {
  kind: string;
  sellerOrBuyer: string;
  protocol: number;
  cosigner: string;
  beneficiary: string;
  marketplace: string;
  fallbackRoyaltyRecipient: string;
  paymentMethod: string;
  tokenAddress: string;
  amount: string;
  itemPrice: string;
  expiration: string;
  marketplaceFeeNumerator: string;
  nonce: string;
  masterNonce: string;
  r: string;
  s: string;
  v: number;
}

interface Order {
  kind: string;
  data: OrderData;
}

interface Item {
  order: Order;
  orderbook: string;
}

interface SignedData {
  items: Item[];
  source: string;
}