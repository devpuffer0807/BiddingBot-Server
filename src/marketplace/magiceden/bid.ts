import { BigNumber, Contract, ethers, Wallet } from "ethers";
import { axiosInstance, limiter } from "../../init";
import { MAGICEDEN_CONTRACT_ADDRESS, WETH_CONTRACT_ADDRESS, WETH_MIN_ABI } from "../../constants";
import { config } from "dotenv";
import { ensureAllowance } from "../../functions";
import { MAGENTA, RESET } from "../..";
import redisClient from "../../utils/redis";

config()

const API_KEY = process.env.API_KEY as string;
const ALCHEMY_API_KEY = "HGWgCONolXMB2op5UjPH1YreDCwmSbvx"
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
  tokenId?: string | number
) {

  const expiry = Math.ceil(Number(expirationTime) - (Date.now() / 1000))

  const wallet = new Wallet(privateKey, provider);
  const wethContract = new Contract(WETH_CONTRACT_ADDRESS,
    WETH_MIN_ABI, wallet);

  const offerPrice = BigNumber.from(weiPrice);
  await ensureAllowance(wethContract, wallet.address, offerPrice, MAGICEDEN_CONTRACT_ADDRESS);

  const order = await createBidData(maker, collection, quantity, weiPrice, expirationTime, trait, tokenId);

  if (order) {
    const res = await tokenId ?
      submitSignedOrderData(order, wallet, slug, expiry, undefined, tokenId)
      : trait ? submitSignedOrderData(order, wallet, slug, expiry, trait, undefined)
        : submitSignedOrderData(order, wallet, slug, expiry, undefined, undefined)
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
      "conduitKey": "0x87328c9043E7BF343695554EAAF5a8892f7205e3000000000000000000000000"
    }
  } : {
    "payment-processor-v2": {
      useOffChainCancellation: true
    }
  }

  const orderKind = trait || tokenId ? "seaport-v1.6" : "payment-processor-v2"
  const params = [
    {
      ...(tokenId ? {} : { collection: collection }),
      currency: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      quantity: quantity,
      weiPrice: weiPrice,
      expirationTime: expirationTime,
      orderKind: orderKind,
      orderbook: "reservoir",
      options: options,
      automatedRoyalties: true,
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
async function sendSignedOrderData(signature: string, data: SignedData, slug: string, expiry: number = 900, trait?: Trait, tokenId?: number | string) {

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

    const orderKey = trait
      ? `${JSON.stringify(trait)}`
      : "default"

    const key = `magiceden:order:${slug}:${orderKey}`;
    const order = JSON.stringify(offerResponse)

    await redis.setex(key, expiry, order);
    console.log(MAGENTA, successMessage, RESET);
    return offerResponse;
  } catch (error: any) {
    console.log(error.response.data);
  }
}

/**
 * Submits signed order data.
 * @param order - The order data.
 * @param wallet - The wallet of the offerer.
 * @param trait - Optional Trait
 * @param slug - Collection slug

 */
export async function submitSignedOrderData(order: CreateBidData, wallet: ethers.Wallet, slug: string, expiry = 900, trait?: Trait, tokenId?: number | string) {
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
    return await sendSignedOrderData(signature, data, slug, expiry, trait, tokenId);
  } catch (error: any) {
    console.error('Error in submitSignedOrderData:', error);
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
    const signature = await signCancelOrder(cancelItem, privateKey)
    const body = cancelStep?.items[0].data.post.body

    const { data: cancelResponse } = await limiter.schedule(() => axiosInstance.post(`https://api.nfttools.website/magiceden/v3/rtp/ethereum/execute/cancel-signature/v1?signature=${signature}`, body, {
      headers: {
        'content-type': 'application/json',
        'X-NFT-API-Key': API_KEY
      }
    }))

    console.log(JSON.stringify(cancelResponse));
  } catch (error) {
    console.log(error);
  }
}

async function signCancelOrder(cancelItem: SignCancel | undefined, privateKey: string) {
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


// https://api-mainnet.magiceden.io/v3/rtp/ethereum/execute/bid/v5


// {"maker":"0x06c0971e22bd902Fb4DC0cEcb214F1653F1A7B94","source":"magiceden.io","params":[{"weiPrice":"10000000000000000","currency":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","quantity":1,"orderbook":"reservoir","orderKind":"seaport-v1.6","options":{"seaport-v1.6":{"useOffChainCancellation":true,"conduitKey":"0x87328c9043E7BF343695554EAAF5a8892f7205e3000000000000000000000000"}},"expirationTime":"1729357920","token":"0xa9f0a21b795a0ad2782c9ed82816c7e5b40cede4:155","automatedRoyalties":true}]}


const response = {
  "steps": [
    {
      "id": "currency-wrapping",
      "action": "Wrapping currency",
      "description": "We'll ask your approval to wrap the currency for bidding. Gas fee required.",
      "kind": "transaction",
      "items": []
    },
    {
      "id": "currency-approval",
      "action": "Approve currency",
      "description": "We'll ask your approval for the exchange to access your token. This is a one-time only operation per exchange.",
      "kind": "transaction",
      "items": [
        {
          "status": "complete",
          "orderIndexes": [
            0
          ]
        }
      ]
    },
    {
      "id": "auth-transaction",
      "action": "On-chain verification",
      "description": "Some marketplaces require triggering an auth transaction before filling",
      "kind": "transaction",
      "items": []
    },
    {
      "id": "currency-permit",
      "action": "Sign permits",
      "description": "Sign permits for accessing the tokens in your wallet",
      "kind": "signature",
      "items": []
    },
    {
      "id": "order-signature",
      "action": "Authorize offer",
      "description": "A free off-chain signature to create the offer",
      "kind": "signature",
      "items": [
        {
          "status": "incomplete",
          "data": {
            "sign": {
              "signatureKind": "eip712",
              "domain": {
                "name": "Seaport",
                "version": "1.6",
                "chainId": 1,
                "verifyingContract": "0x0000000000000068f116a894984e2db1123eb395"
              },
              "types": {
                "OrderComponents": [
                  {
                    "name": "offerer",
                    "type": "address"
                  },
                  {
                    "name": "zone",
                    "type": "address"
                  },
                  {
                    "name": "offer",
                    "type": "OfferItem[]"
                  },
                  {
                    "name": "consideration",
                    "type": "ConsiderationItem[]"
                  },
                  {
                    "name": "orderType",
                    "type": "uint8"
                  },
                  {
                    "name": "startTime",
                    "type": "uint256"
                  },
                  {
                    "name": "endTime",
                    "type": "uint256"
                  },
                  {
                    "name": "zoneHash",
                    "type": "bytes32"
                  },
                  {
                    "name": "salt",
                    "type": "uint256"
                  },
                  {
                    "name": "conduitKey",
                    "type": "bytes32"
                  },
                  {
                    "name": "counter",
                    "type": "uint256"
                  }
                ],
                "OfferItem": [
                  {
                    "name": "itemType",
                    "type": "uint8"
                  },
                  {
                    "name": "token",
                    "type": "address"
                  },
                  {
                    "name": "identifierOrCriteria",
                    "type": "uint256"
                  },
                  {
                    "name": "startAmount",
                    "type": "uint256"
                  },
                  {
                    "name": "endAmount",
                    "type": "uint256"
                  }
                ],
                "ConsiderationItem": [
                  {
                    "name": "itemType",
                    "type": "uint8"
                  },
                  {
                    "name": "token",
                    "type": "address"
                  },
                  {
                    "name": "identifierOrCriteria",
                    "type": "uint256"
                  },
                  {
                    "name": "startAmount",
                    "type": "uint256"
                  },
                  {
                    "name": "endAmount",
                    "type": "uint256"
                  },
                  {
                    "name": "recipient",
                    "type": "address"
                  }
                ]
              },
              "value": {
                "offerer": "0x06c0971e22bd902fb4dc0cecb214f1653f1a7b94",
                "zone": "0x2d1a340cd83434243d090931afabf95b7d3078b0",
                "offer": [
                  {
                    "itemType": 1,
                    "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                    "identifierOrCriteria": "0",
                    "startAmount": "10000000000000000",
                    "endAmount": "10000000000000000"
                  }
                ],
                "consideration": [
                  {
                    "itemType": 2,
                    "token": "0xa9f0a21b795a0ad2782c9ed82816c7e5b40cede4",
                    "identifierOrCriteria": "155",
                    "startAmount": "1",
                    "endAmount": "1",
                    "recipient": "0x06c0971e22bd902fb4dc0cecb214f1653f1a7b94"
                  },
                  {
                    "itemType": 1,
                    "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                    "identifierOrCriteria": "0",
                    "startAmount": "200000000000000",
                    "endAmount": "200000000000000",
                    "recipient": "0x6fa303e72bed54f515a513496f922bc331e2f27e"
                  }
                ],
                "orderType": 2,
                "startTime": 1726765907,
                "endTime": 1729357920,
                "zoneHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
                "salt": "0x0e1c0c381d4da48b00000000000000006bdeb0809e69d948e0207099aaa3e423",
                "conduitKey": "0x87328c9043e7bf343695554eaaf5a8892f7205e3000000000000000000000000",
                "counter": "0"
              },
              "primaryType": "OrderComponents"
            },
            "post": {
              "endpoint": "/order/v3",
              "method": "POST",
              "body": {
                "order": {
                  "kind": "seaport-v1.6",
                  "data": {
                    "kind": "single-token",
                    "offerer": "0x06c0971e22bd902fb4dc0cecb214f1653f1a7b94",
                    "zone": "0x2d1a340cd83434243d090931afabf95b7d3078b0",
                    "offer": [
                      {
                        "itemType": 1,
                        "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                        "identifierOrCriteria": "0",
                        "startAmount": "10000000000000000",
                        "endAmount": "10000000000000000"
                      }
                    ],
                    "consideration": [
                      {
                        "itemType": 2,
                        "token": "0xa9f0a21b795a0ad2782c9ed82816c7e5b40cede4",
                        "identifierOrCriteria": "155",
                        "startAmount": "1",
                        "endAmount": "1",
                        "recipient": "0x06c0971e22bd902fb4dc0cecb214f1653f1a7b94"
                      },
                      {
                        "itemType": 1,
                        "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                        "identifierOrCriteria": "0",
                        "startAmount": "200000000000000",
                        "endAmount": "200000000000000",
                        "recipient": "0x6fa303e72bed54f515a513496f922bc331e2f27e"
                      }
                    ],
                    "orderType": 2,
                    "startTime": 1726765907,
                    "endTime": 1729357920,
                    "zoneHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
                    "salt": "0x0e1c0c381d4da48b00000000000000006bdeb0809e69d948e0207099aaa3e423",
                    "conduitKey": "0x87328c9043e7bf343695554eaaf5a8892f7205e3000000000000000000000000",
                    "counter": "0",
                    "signature": "0x0000000000000000000000000000000000000000000000000000000000000000"
                  }
                },
                "isNonFlagged": false,
                "orderbook": "reservoir",
                "source": "magiceden.io"
              }
            }
          },
          "orderIndexes": [
            0
          ]
        }
      ]
    }
  ],
  "errors": []
}


// https://api-mainnet.magiceden.io/v3/rtp/ethereum/order/v3?signature=0x14ac5077760b90b1fde33d8ad4f1b7648515941caa1d9820cd02e4d244ebb3a97270d9dfc7cc73f57a6424deb801cc366d084cfdb081c3cbddd72b2f86bcf46c1c


// {"order":{"kind":"seaport-v1.6","data":{"kind":"single-token","offerer":"0x06c0971e22bd902fb4dc0cecb214f1653f1a7b94","zone":"0x2d1a340cd83434243d090931afabf95b7d3078b0","offer":[{"itemType":1,"token":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","identifierOrCriteria":"0","startAmount":"10000000000000000","endAmount":"10000000000000000"}],"consideration":[{"itemType":2,"token":"0xa9f0a21b795a0ad2782c9ed82816c7e5b40cede4","identifierOrCriteria":"155","startAmount":"1","endAmount":"1","recipient":"0x06c0971e22bd902fb4dc0cecb214f1653f1a7b94"},{"itemType":1,"token":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","identifierOrCriteria":"0","startAmount":"200000000000000","endAmount":"200000000000000","recipient":"0x6fa303e72bed54f515a513496f922bc331e2f27e"}],"orderType":2,"startTime":1726765907,"endTime":1729357920,"zoneHash":"0x0000000000000000000000000000000000000000000000000000000000000000","salt":"0x0e1c0c381d4da48b00000000000000006bdeb0809e69d948e0207099aaa3e423","conduitKey":"0x87328c9043e7bf343695554eaaf5a8892f7205e3000000000000000000000000","counter":"0","signature":"0x0000000000000000000000000000000000000000000000000000000000000000"}},"isNonFlagged":false,"orderbook":"reservoir","source":"magiceden.io"}