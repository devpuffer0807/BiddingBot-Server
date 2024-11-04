import { ethers, Wallet } from "ethers";
import { axiosInstance, limiter } from "../../init";
import { config } from "dotenv";
import { MAGENTA } from "../..";
import redisClient from "../../utils/redis";
import { getWethBalance } from "../../utils/balance";

const RED = '\x1b[31m';
const RESET = '\x1b[0m';

config()

const API_KEY = process.env.API_KEY as string;
const ALCHEMY_API_KEY = "0rk2kbu11E5PDyaUqX1JjrNKwG7s4ty5"
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
  bidCount: number,
  maker: string,
  collection: string,
  quantity: number,
  weiPrice: string,
  expirationTime: string,
  privateKey: string,
  slug: string,
  trait?: Trait,
  tokenId?: string | number
) {
  const expiry = Math.ceil(Number(expirationTime) - (Date.now() / 1000))
  const wallet = new Wallet(privateKey, provider);
  const offerPriceEth = Number(weiPrice) / 1e18
  const wethBalance = await getWethBalance(maker)

  if (offerPriceEth > wethBalance) {
    console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
    console.log(RED + `Offer price: ${offerPriceEth} WETH  is greater than available WETH balance: ${wethBalance} WETH. SKIPPING ...`.toUpperCase() + RESET);
    console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
    return
  }

  const order = await createBidData(maker, collection, quantity, weiPrice.toString(), expirationTime, trait, tokenId);

  if (order) {
    const res = await tokenId ?
      submitSignedOrderData(bidCount, order, wallet, slug, expiry, undefined, tokenId)
      : trait ? submitSignedOrderData(bidCount, order, wallet, slug, expiry, trait, undefined)
        : submitSignedOrderData(bidCount, order, wallet, slug, expiry, undefined, undefined)
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
  trait?: Trait,
  tokenId?: number | string,
) {

  const options = trait || tokenId ? {
    "seaport-v1.6": {
      "useOffChainCancellation": true,
      "conduitKey": "0x87328c9043E7BF343695554EAAF5a8892f7205e3000000000000000000000000",

    }
  } : {
    "payment-processor-v2": {
      useOffChainCancellation: true,
    }
  }

  const orderKind = trait || tokenId ? "seaport-v1.6" : "payment-processor-v2"
  const params = [
    {
      ...(tokenId ? {} : { collection: collection }),
      currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      quantity: quantity,
      weiPrice: weiPrice.toString(),
      expirationTime: expirationTime,
      orderKind: orderKind,
      orderbook: "reservoir",
      options: options,
      automatedRoyalties: false,
      ...(tokenId ? { token: `${collection}:${tokenId}` } : trait ? { attributeKey: trait.attributeKey, attributeValue: trait.attributeValue } : {})
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
    console.log(error.response.data);
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
async function sendSignedOrderData(bidCount: number, signature: string, data: SignedData, slug: string, expiry: number = 900, trait?: Trait, tokenId?: number | string) {

  const endpoint = trait || tokenId
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

    const successMessage = tokenId ? `🎉 TOKEN OFFER POSTED TO MAGICEDEN SUCCESSFULLY FOR: ${slug.toUpperCase()} TOKEN: ${tokenId} 🎉` :
      trait ?
        `🎉 TRAIT OFFER POSTED TO MAGICEDEN SUCCESSFULLY FOR: ${slug.toUpperCase()} TRAIT: ${JSON.stringify(trait)} 🎉`
        : `🎉 OFFER POSTED TO MAGICEDEN SUCCESSFULLY FOR: ${slug.toUpperCase()} 🎉`

    const orderKey =
      tokenId ?
        `${JSON.stringify(tokenId)}` :
        trait
          ? `${JSON.stringify(trait)}`
          : "default"

    const baseKey = `magiceden:order:${slug}:${orderKey}`;
    const order = JSON.stringify(offerResponse);

    const key = `${bidCount}:${baseKey}`;

    // Add retry logic and error handling for Redis operations
    let retries = 3;
    while (retries > 0) {
      try {
        await redis.setex(key, expiry, order);
        break;
      } catch (redisError) {
        console.error(`Redis error (${retries} retries left):`, redisError);
        retries--;
        if (retries === 0) {
          throw redisError;
        }
        // Wait 1 second before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(MAGENTA, successMessage, RESET);
    return offerResponse;
  } catch (error: any) {
    // Enhanced error logging
    const errorMessage = error?.response?.data?.message?.message ||
      error?.response?.data?.message ||
      error?.message ||
      'Unknown error';

    console.error('Magic Eden API Error:', {
      endpoint,
      errorMessage,
      statusCode: error?.response?.status,
      details: error?.response?.data,
      tokenId: tokenId ? `Token ID: ${tokenId}` : undefined,
      trait: trait ? `Trait: ${JSON.stringify(trait)}` : undefined,
      collection: slug
    });

    // Return null instead of throwing
    return null;
  }
}

/**
 * Submits signed order data.
 * @param order - The order data.
 * @param wallet - The wallet of the offerer.
 * @param trait - Optional Trait
 * @param slug - Collection slug

 */
export async function submitSignedOrderData(bidCount: number, order: CreateBidData, wallet: ethers.Wallet, slug: string, expiry = 900, trait?: Trait, tokenId?: number | string) {
  try {
    const signData = order?.steps
      ?.find((step) => step.id === "order-signature")
      ?.items?.[0]?.data?.sign;

    if (!signData || !signData.value) {
      throw new Error('Invalid order signature data');
    }

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
    } else if (tokenId) {
      data = order?.steps
        ?.find((step) => step.id === "order-signature")
        ?.items?.[0]?.data?.post.body;
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
    const result = await sendSignedOrderData(bidCount, signature, data, slug, expiry, trait, tokenId);
    return result;
  } catch (error: any) {
    // Enhanced error logging
    const errorDetails = {
      slug,
      trait: trait ? JSON.stringify(trait) : undefined,
      tokenId,
      error: error?.message || 'Unknown error',
      response: error?.response?.data
    };

    console.error('Error in submitSignedOrderData:', errorDetails);

    // Return null instead of throwing
    return null;
  }

}

export async function canelMagicEdenBid(orderIds: string[], privateKey: string) {
  try {
    const { data } = await limiter.schedule(() => axiosInstance.post<MagicEdenCancelOfferCancel>('https://api.nfttools.website/magiceden/v3/rtp/ethereum/execute/cancel/v3', { orderIds }, {
      headers: {
        'content-type': 'application/json',
        'X-NFT-API-Key': API_KEY
      }
    }));
    const cancelStep = data?.steps?.find((step) => step.id === "cancellation-signature")
    const cancelItem = cancelStep?.items[0]?.data?.sign
    const cancelData = cancelItem ? cancelItem : {
      "signatureKind": "eip712",
      "domain": {
        "name": "Off-Chain Cancellation",
        "version": "1.0.0",
        "chainId": 1
      },
      "types": { "OrderHashes": [{ "name": "orderHashes", "type": "bytes32[]" }] },
      "value": {
        "orderHashes": [...orderIds]
      },
      "primaryType": "OrderHashes"
    }
    const signature = await signCancelOrder(cancelData, privateKey)
    const body = cancelStep?.items[0].data.post.body
    const cancelBody = cancelItem ? body : {
      orderIds: [
        ...orderIds
      ],
      orderKind: 'payment-processor-v2'
    }
    const { data: cancelResponse } = await limiter.schedule(() => axiosInstance.post(`https://api.nfttools.website/magiceden/v3/rtp/ethereum/execute/cancel-signature/v1?signature=${signature}`, cancelBody, {
      headers: {
        'content-type': 'application/json',
        'X-NFT-API-Key': API_KEY
      }
    }))

    console.log(JSON.stringify(cancelResponse));
  } catch (error: any) {
    console.log(error?.response?.data?.message || JSON.stringify(error));
  }
}

async function signCancelOrder(cancelItem: any | undefined, privateKey: string) {
  try {
    if (!cancelItem) {
      console.log('INVALID CANCEL DATA');
      return
    }
    const wallet = new Wallet(privateKey, provider);
    const signature = await wallet._signTypedData(
      cancelItem.domain,
      cancelItem.types,
      cancelItem.value
    );

    return signature;
  } catch (error) {
    console.log(error);

  }
}

export async function fetchMagicEdenOffer(type: "COLLECTION" | "TRAIT" | "TOKEN", walletAddress: string, contractAddress: string, identifier?: string | Record<string, string>) {
  try {

    const URL = `https://api.nfttools.website/magiceden/v3/rtp/ethereum/orders/bids/v6`;
    if (type === "COLLECTION") {
      const queryParams = {
        collection: contractAddress,
        sortBy: 'price',
        status: 'active',
        excludeEOA: 'false',
        includeCriteriaMetadata: 'true',
        includeDepth: 'true',
        normalizeRoyalties: 'false'
      }

      const { data } = await limiter.schedule(() =>
        axiosInstance.get(URL, {
          params: queryParams,
          headers: {
            'content-type': 'application/json',
            'X-NFT-API-Key': API_KEY
          }
        })
      );

      const offer = data.orders.filter((order: any) => order.maker.toLowerCase() !== walletAddress.toLocaleLowerCase())[0].price
      return offer

    } else if (type === "TOKEN") {
      const queryParams = {
        token: `${contractAddress}:${identifier}`,
        sortBy: 'price',
        status: 'active',
        excludeEOA: 'false',
        limit: '100',
        normalizeRoyalties: 'false'
      };

      const { data } = await limiter.schedule(() =>
        axiosInstance.get(URL, {
          params: queryParams,
          headers: {
            'content-type': 'application/json',
            'X-NFT-API-Key': API_KEY
          }
        })
      );
      const offer = data?.orders?.filter((order: any) => order.maker.toLowerCase() !== walletAddress.toLocaleLowerCase())[0]?.price || 0
      return offer
    }

  } catch (error: any) {
    console.log(error);
  }
}


export async function fetchMagicEdenCollectionStats(contractAddress: string) {
  const queryParams = {
    chain: 'ethereum',
    collectionId: contractAddress
  };
  try {
    const { data } = await limiter.schedule(() => axiosInstance.get('https://api.nfttools.website/magiceden_stats/collection_stats/stats', {
      params: queryParams,
      headers: {
        'X-NFT-API-Key': API_KEY
      }
    }));
    return +data.floorPrice.amount
  } catch (error) {
    console.error('Error fetching Magic Eden collection stats:', error);
    return 0
  }
}

export async function fetchMagicEdenTokens(collectionId: string, limit: number = 50) {
  const params: any = {
    excludeSpam: true,
    excludeBurnt: true,
    collection: collectionId,
    sortBy: "floorAskPrice",
    sortDirection: "asc",
    limit: 50, // Set limit to 50 for each request
    excludeSources: ["nftx.io", "sudoswap.xyz"],
    normalizeRoyalties: false,
    continuation: null
  };
  const url = `https://api.nfttools.website/magiceden/v3/rtp/ethereum/tokens/v7`;
  const allTokens: number[] = [];
  try {
    let totalFetched = 0;

    do {
      const { data } = await limiter.schedule(() => axiosInstance.get<TokenResponseMagiceden>(url, {
        headers: {
          accept: "application/json",
          "X-NFT-API-Key": API_KEY,
        },
        params
      }))

      const tokens = data.tokens.map((item) => +item.token.tokenId);
      allTokens.push(...tokens);
      totalFetched += tokens.length;
      params.continuation = data.continuation;

    } while (params.continuation && totalFetched < limit);
    return allTokens.slice(0, limit);
  } catch (error) {
    console.error("Error fetching Magic Eden tokens:", error);
    return []
  }
}


interface TokenMagiceden {
  chainId: number;
  contract: string;
  tokenId: string;
  name: string;
  description: string;
  image: string;
  imageSmall: string;
  imageLarge: string;
  metadata: {
    imageOriginal: string;
    imageMimeType: string;
    tokenURI: string;
  };
  media: any; // Adjust type if you know the structure of media
  kind: string;
  isFlagged: boolean;
  isSpam: boolean;
  isNsfw: boolean;
  metadataDisabled: boolean;
  lastFlagUpdate: string;
  lastFlagChange: string;
  supply: string;
  remainingSupply: string;
  rarity: number;
  rarityRank: number;
  collection: {
    id: string;
    name: string;
    image: string;
    slug: string;
    symbol: string;
    creator: string;
    tokenCount: number;
    metadataDisabled: boolean;
    floorAskPrice: {
      currency: {
        contract: string;
        name: string;
        symbol: string;
        decimals: number;
      };
      amount: {
        raw: string;
        decimal: number;
        usd: number;
        native: number;
      };
    };
  };
  owner: string;
  mintedAt: string;
  createdAt: string;
  decimals: number | null;
  mintStages: any[]; // Adjust type if you know the structure of mintStages
}

interface MarketMagiceden {
  floorAsk: {
    id: string;
    price: {
      currency: {
        contract: string;
        name: string;
        symbol: string;
        decimals: number;
      };
      amount: {
        raw: string;
        decimal: number;
        usd: number;
        native: number;
      };
    };
    maker: string;
    validFrom: number;
    validUntil: number;
    source: {
      id: string;
      domain: string;
      name: string;
      icon: string;
      url: string;
    };
  };
}

interface TokenResponseMagiceden {
  tokens: {
    token: TokenMagiceden;
    market: MarketMagiceden;
    updatedAt: string;
    media: {
      image: string;
      imageMimeType: string;
    };
  }[];
  continuation: string;
}


interface MagicEdenCancelOfferCancel {
  steps: StepCancel[];
}

interface StepCancel {
  id: string;
  action: string;
  description: string;
  kind: string;
  items: ItemCancel[];
}

interface ItemCancel {
  status: string;
  orderIds: string[];
  data: DataCancel;
}

interface DataCancel {
  sign: SignCancel;
  post: PostCancel;
}

interface SignCancel {
  signatureKind: string;
  domain: DomainCancel;
  types: any;
  value: ValueCancel;
}

interface DomainCancel {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

interface TypesCancel {
  OrderHashes: OrderHashCancel[];
}

interface OrderHashCancel {
  name: string;
  type: string;
}

interface ValueCancel {
  orderHashes: string[];
}

interface PostCancel {
  endpoint: string;
  method: string;
  body: BodyCancel;
}

interface BodyCancel {
  orderIds: string[];
  orderKind: string;
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

