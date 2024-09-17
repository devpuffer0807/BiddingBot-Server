import { BigNumber, Contract, ethers, Wallet } from "ethers";
import { axiosInstance, limiter } from "../../init";
import { MAGICEDEN_CONTRACT_ADDRESS, WETH_CONTRACT_ADDRESS, WETH_MIN_ABI } from "../../constants";
import { config } from "dotenv";
import { ensureAllowance } from "../../functions";
import { MAGENTA, RESET } from "../..";
import redisClient from "../../utils/redis";

config()

const API_KEY = process.env.API_KEY as string;
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY
const provider = new ethers.providers.AlchemyProvider('mainnet', ALCHEMY_API_KEY);

const redis = redisClient.getClient();

/**
 * Places a bid on Magic Eden.
 * @param maker - The maker of the bid.
 * @param collection - The collection to bid on.
 * @param quantity - The quantity to bid.
 * @param weiPrice - The price in wei.
 * @param expirationTime - The expiration time of the bid.
 * @param privateKey - The private key of the maker's wallet.
 * @param slug - Collection slug
 * @param traits - Optional traits for the offer.
 */

export async function bidOnMagiceden(
  maker: string,
  collection: string,
  quantity: number,
  weiPrice: string,
  expirationTime: string,
  privateKey: string,
  slug: string,
  trait?: Trait,
) {

  const expiry = Math.ceil(Number(expirationTime) - (Date.now() / 1000))

  const wallet = new Wallet(privateKey, provider);
  const wethContract = new Contract(WETH_CONTRACT_ADDRESS,
    WETH_MIN_ABI, wallet);

  const offerPrice = BigNumber.from(weiPrice);
  await ensureAllowance(wethContract, wallet.address, offerPrice, MAGICEDEN_CONTRACT_ADDRESS);

  const order = await createBidData(maker, collection, quantity, weiPrice, expirationTime, trait);

  if (order) {
    const res = await submitSignedOrderData(order, wallet, slug, expiry, trait)
    return res
  }
  return order

}

/**
 * Creates bid data for Magic Eden.
 * @param maker - The maker of the bid.
 * @param collection - The collection to bid on.
 * @param quantity - The quantity to bid.
 * @param weiPrice - The price in wei.
 * @param expirationTime - The expiration time of the bid.
 * @param traits - Optional traits for the offer.
 * @returns The bid data.
 */
async function createBidData(
  maker: string,
  collection: string,
  quantity: number,
  weiPrice: string,
  expirationTime: string,
  trait?: Trait
) {

  const options = trait ? {
    "seaport-v1.6": {
      "useOffChainCancellation": true,
      "conduitKey": "0x87328c9043E7BF343695554EAAF5a8892f7205e3000000000000000000000000"
    }
  } : {
    "payment-processor-v2": {
      useOffChainCancellation: true
    }
  }

  const orderKind = trait ? "seaport-v1.6" : "payment-processor-v2"
  const params = [
    {
      collection: collection,
      currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      quantity: quantity,
      weiPrice: weiPrice,
      expirationTime: expirationTime,
      orderKind: orderKind,
      orderbook: "reservoir",
      options: options,
      automatedRoyalties: true,
      ...(trait ? { attributeKey: trait.attributeKey, attributeValue: trait.attributeValue } : {})
    }
  ];

  const data = {
    maker: maker,
    source: "magiceden.io",
    params: params
  };

  let response: any;
  try {
    const { data: order } = await limiter.schedule(() => axiosInstance.post<CreateBidData>('https://api.nfttools.website/magiceden/v3/rtp/ethereum/execute/bid/v5', data, {
      headers: {
        'content-type': 'application/json',
        'X-NFT-API-Key': API_KEY
      }
    }));
    response = order
    return order;

  } catch (error: any) {
    console.log(error);
  } finally {
    return response
  }
}


/**
 * Signs the order data.
 * @param wallet - The wallet of the offerer.
 * @param signData - The data to be signed.
 * @returns The signature.
 */
async function signOrderData(wallet: ethers.Wallet, signData: any, trait?: Trait): Promise<string> {
  const domain = trait ? {
    "name": "Seaport",
    "version": "1.6",
    "chainId": 1,
    "verifyingContract": "0x0000000000000068f116a894984e2db1123eb395"
  } : signData.domain

  const types = trait ? {
    "OrderComponents": [
      { "name": "offerer", "type": "address" },
      { "name": "zone", "type": "address" },
      { "name": "offer", "type": "OfferItem[]" },
      { "name": "consideration", "type": "ConsiderationItem[]" },
      { "name": "orderType", "type": "uint8" },
      { "name": "startTime", "type": "uint256" },
      { "name": "endTime", "type": "uint256" },
      { "name": "zoneHash", "type": "bytes32" },
      { "name": "salt", "type": "uint256" },
      { "name": "conduitKey", "type": "bytes32" },
      { "name": "counter", "type": "uint256" }
    ],
    "OfferItem": [
      { "name": "itemType", "type": "uint8" },
      { "name": "token", "type": "address" },
      { "name": "identifierOrCriteria", "type": "uint256" },
      { "name": "startAmount", "type": "uint256" },
      { "name": "endAmount", "type": "uint256" }
    ],
    "ConsiderationItem": [
      { "name": "itemType", "type": "uint8" },
      { "name": "token", "type": "address" },
      { "name": "identifierOrCriteria", "type": "uint256" },
      { "name": "startAmount", "type": "uint256" },
      { "name": "endAmount", "type": "uint256" },
      { "name": "recipient", "type": "address" }
    ]
  } : signData.types
  try {
    const signature = await wallet._signTypedData(
      domain,
      types,
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
* @param expiry - bid expiry in seconds
* @param trait - Collection trait
 * @returns The response from the API.
 */
async function sendSignedOrderData(signature: string, data: SignedData, slug: string, expiry: number = 900, trait?: Trait) {

  const endpoint = trait
    ? "https://api.nfttools.website/magiceden/v3/rtp/ethereum/order/v3"
    : "https://api.nfttools.website/magiceden/v3/rtp/ethereum/order/v4"

  try {
    const { data: offerResponse } = await limiter.schedule(() =>
      axiosInstance.post(
        `${endpoint}?signature=${encodeURIComponent(signature)}`,
        data,
        {
          headers: {
            'content-type': 'application/json',
            'X-NFT-API-Key': API_KEY,
          }
        }
      )
    );

    const successMessage = trait ?
      `🎉 TRAIT OFFER POSTED TO MAGICEDEN SUCCESSFULLY FOR: ${slug.toUpperCase()} TRAIT: ${JSON.stringify(trait)} 🎉`
      : `🎉 OFFER POSTED TO MAGICEDEN SUCCESSFULLY FOR: ${slug.toUpperCase()} 🎉`

    const orderKey = trait
      ? `${JSON.stringify(trait)}`
      : "default"

    const key = `magiceden:order:${orderKey}`;
    const order = JSON.stringify(offerResponse)

    await redis.setex(key, expiry, order);
    console.log(MAGENTA, successMessage, RESET);
    return offerResponse;
  } catch (axiosError: any) {
    console.log("something went wrong here");

    if (axiosError.response) {
      console.error('Error response from server:', axiosError.response.data);
    } else if (axiosError.request) {
      console.error('No response received:', axiosError.request);
    } else {
      console.error('Error setting up request:', axiosError.message);
    }
    throw axiosError;
  }
}

/**
 * Submits signed order data.
 * @param order - The order data.
 * @param wallet - The wallet of the offerer.
 * @param trait - Optional Trait
 * @param slug - Collection slug

 */
export async function submitSignedOrderData(order: CreateBidData, wallet: ethers.Wallet, slug: string, expiry = 900, trait?: Trait) {
  const signData = order?.steps
    ?.find((step) => step.id === "order-signature")
    ?.items?.[0]?.data?.sign;

  try {
    if (!signData || !signData.value) return
    const signature = await signOrderData(wallet, signData, trait);
    let data: any;

    if (trait) {
      const orderSignatureStep = order.steps.find(step => step.id === "order-signature") as any;
      const attributeStep = order.steps.find(step => step.id === "order-signature") as any
      const attribute = attributeStep?.items[0]?.data?.post?.body?.attribute;
      const valueObject = orderSignatureStep.items[0].data.sign.value;

      data = {
        "order": {
          "kind": "seaport-v1.6",
          "data": {
            "kind": "token-list",
            ...valueObject,
            "signature": "0x0000000000000000000000000000000000000000000000000000000000000000"
          }
        },
        "attribute": {
          "collection": attribute.collection,
          "key": trait.attributeKey,
          "value": trait.attributeValue
        },
        "isNonFlagged": false,
        "orderbook": "reservoir",
        "source": "magiceden.io"
      };
    } else {
      if (signData) {
        const payload = signData.value;
        const { buyer, ...rest } = payload;
        data = {
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
      } else {
        console.error('Sign data not found in order steps.');
      }
    }
    return await sendSignedOrderData(signature, data, slug, expiry, trait);
  } catch (error: any) {
    console.error('Error in submitSignedOrderData:', error);
  }

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

interface Trait {
  attributeKey: string;
  attributeValue: string;
};