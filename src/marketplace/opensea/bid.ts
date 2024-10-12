import { BigNumber, Contract, ethers, Wallet } from "ethers";
import { SEAPORT_CONTRACT_ADDRESS, SEAPORT_MIN_ABI, WETH_MIN_ABI } from "../../constants";
import { axiosInstance, limiter } from "../../init";
import { ensureAllowance } from "../../functions";
import { BLUE } from "../..";
import redisClient from "../../utils/redis";
import { config } from "dotenv";
import { getWethBalance } from "../../utils/balance";

config()

const API_KEY = process.env.API_KEY as string;
const OPENSEA_ITEM_ZONE = "0x000056f7000000ece9003ca63978907a00ffd100"
const OPENSEA_COLLECTION_ZONE = "0x004C00500000aD104D7DBd00e3ae0A5C00560C00"
const ZONE_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000"
const CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000"
const SEAPORT_1_6 = "0x0000000000000068f116a894984e2db1123eb395"
const WETH_CONTRACT_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
const OPENSEA_FEE_ADDRESS = "0x0000a26b00c1F0DF003000390027140000fAa719"

const ALCHEMY_API_KEY = "HGWgCONolXMB2op5UjPH1YreDCwmSbvx"
const provider = new ethers.providers.AlchemyProvider('mainnet', ALCHEMY_API_KEY);
const SEAPORT_CONTRACT = new ethers.Contract(SEAPORT_CONTRACT_ADDRESS, SEAPORT_MIN_ABI, provider);
const RED = '\x1b[31m';
const RESET = '\x1b[0m';


const redis = redisClient.getClient();

const domain = {
  name: 'Seaport',
  version: '1.6',
  chainId: '1',
  verifyingContract: SEAPORT_1_6
};

const types = {
  OrderComponents: [
    {
      name: 'offerer',
      type: 'address'
    },
    {
      name: 'zone',
      type: 'address'
    },
    {
      name: 'offer',
      type: 'OfferItem[]'
    },
    {
      name: 'consideration',
      type: 'ConsiderationItem[]'
    },
    {
      name: 'orderType',
      type: 'uint8'
    },
    {
      name: 'startTime',
      type: 'uint256'
    },
    {
      name: 'endTime',
      type: 'uint256'
    },
    {
      name: 'zoneHash',
      type: 'bytes32'
    },
    {
      name: 'salt',
      type: 'uint256'
    },
    {
      name: 'conduitKey',
      type: 'bytes32'
    },
    {
      name: 'counter',
      type: 'uint256'
    }
  ],
  OfferItem: [
    {
      name: 'itemType',
      type: 'uint8'
    },
    {
      name: 'token',
      type: 'address'
    },
    {
      name: 'identifierOrCriteria',
      type: 'uint256'
    },
    {
      name: 'startAmount',
      type: 'uint256'
    },
    {
      name: 'endAmount',
      type: 'uint256'
    }
  ],
  ConsiderationItem: [
    {
      name: 'itemType',
      type: 'uint8'
    },
    {
      name: 'token',
      type: 'address'
    },
    {
      name: 'identifierOrCriteria',
      type: 'uint256'
    },
    {
      name: 'startAmount',
      type: 'uint256'
    },
    {
      name: 'endAmount',
      type: 'uint256'
    },
    {
      name: 'recipient',
      type: 'address'
    }
  ]
};


async function buildItemOffer(offerSpecification: ItemOfferSpecification) {
  try {
    const {
      assetContractAddress,
      tokenId,
      quantity,
      priceWei,
      expirationSeconds,
      walletAddress
    } = offerSpecification

    const consideration = await getItemConsideration(
      assetContractAddress,
      tokenId,
      quantity,
      walletAddress
    )

    const now = BigInt(Math.floor(Date.now() / 1000))
    const startTime = now.toString()
    const endTime = (now + expirationSeconds).toString()

    const offer = {
      offerer: walletAddress,
      offer: getOffer(priceWei),
      consideration,
      startTime,
      endTime,
      orderType: 2,
      zone: OPENSEA_ITEM_ZONE,
      zoneHash: ZONE_HASH,
      salt: getSalt(),
      conduitKey: CONDUIT_KEY,
      totalOriginalConsiderationItems: consideration.length.toString(),
      counter: 0,
    }

    return offer
  } catch (error) {
    console.log(error);
  }
}
/**
 * Creates an offer on OpenSea.
 * @param walletAddress - The wallet address of the offerer.
 * @param privateKey - The private key of the offerer's wallet.
 * @param slug - The slug of the collection.
 * @param offerPrice - The price of the offer in wei.
 * @param creatorFees - The fees for the creators.
 * @param enforceCreatorFee - Whether to enforce creator fees.
 * @param expiry - bid expiry in seconds.
 * @param openseaTraits - Optional traits for the offer.
 */
export async function bidOnOpensea(
  wallet_address: string,
  private_key: string,
  slug: string,
  offer_price: bigint,
  creator_fees: IFee,
  enforceCreatorFee: boolean,
  expiry: number = 900,
  opensea_traits?: string,
  asset?: { contractAddress: string, tokenId: number }
) {
  const divider = BigNumber.from(10000);
  const roundedNumber = Math.round(Number(offer_price) / 1e14) * 1e14;
  const offerPrice = BigNumber.from(roundedNumber.toString());

  const offerPriceEth = Number(offer_price) / 1e18
  const wethBalance = await getWethBalance(wallet_address)

  if (offerPriceEth > wethBalance) {
    console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
    console.log(RED + `Offer price: ${offerPriceEth} WETH  is greater than available WETH balance: ${wethBalance} WETH. SKIPPING ...`.toUpperCase() + RESET);
    console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
    return
  }

  const wallet = new Wallet(private_key, provider);
  const openseaFee = BigNumber.from(250);


  if (asset) {
    const offer = await buildItemOffer({
      assetContractAddress: asset.contractAddress,
      tokenId: asset.tokenId.toString(),
      walletAddress: wallet_address,
      quantity: 1,
      expirationSeconds: BigInt(expiry),
      priceWei: BigInt(roundedNumber)
    })

    const opensea_consideration = {
      itemType: 1,
      token: WETH_CONTRACT_ADDRESS,
      identifierOrCriteria: "0",
      startAmount: +offerPrice.mul(openseaFee).div(divider),
      endAmount: +offerPrice.mul(openseaFee).div(divider),
      recipient: OPENSEA_FEE_ADDRESS
    };

    if (!offer) {
      console.log("NO OFFER CREATED FOR OPENSEA");
      return
    }
    offer.consideration.push(opensea_consideration);
    offer.totalOriginalConsiderationItems = (Number(offer.totalOriginalConsiderationItems) + 1).toString();
    for (const address in creator_fees) {
      let fee: BigNumber | number = creator_fees[address];
      fee = BigNumber.from(Math.round(fee).toString());
      if (enforceCreatorFee) {
        const consideration_item = {
          itemType: 1,
          token: WETH_CONTRACT_ADDRESS,
          identifierOrCriteria: "0",
          startAmount: Number(offerPrice.mul(fee).div(divider)),
          endAmount: Number(offerPrice.mul(fee).div(divider)),
          recipient: address
        };
        offer.consideration.push(consideration_item);
        offer.totalOriginalConsiderationItems = (Number(offer.totalOriginalConsiderationItems) + 1).toString();
      }
    }

    const itemSignature = await signOffer(wallet, offer)
    const itemResponse = await postItemOffer(offer, itemSignature)
    const itemOrderHash = itemResponse?.order?.order_hash
    const key = `opensea:order:${slug}:${asset.tokenId}`;
    await redis.setex(key, expiry, itemOrderHash);
    const successMessage = `🎉 TOKEN OFFER POSTED TO OPENSEA SUCCESSFULLY FOR: ${slug.toUpperCase()}  TOKEN: ${asset.tokenId} 🎉`
    console.log(BLUE, JSON.stringify(successMessage), RESET);
  }
  else {
    const divider = BigNumber.from(10000);
    const roundedNumber = Math.round(Number(offer_price) / 1e14) * 1e14;
    const offerPrice = BigNumber.from(roundedNumber.toString());

    const payload: IPayload = {
      criteria: {
        collection: {
          slug: slug
        }
      },
      protocol_data: {
        parameters: {
          offerer: wallet_address,
          offer: [
            {
              itemType: 1,
              token: WETH_CONTRACT_ADDRESS,
              identifierOrCriteria: 0,
              startAmount: (Date.now() / 1000).toString(),
              endAmount: (Date.now() / 1000 + 100000).toString()
            }
          ],
          consideration: [],
          startTime: '1666480886',
          endTime: '1666680886',
          orderType: 2,
          zone: OPENSEA_COLLECTION_ZONE,
          zoneHash: ZONE_HASH,
          conduitKey: CONDUIT_KEY,
          totalOriginalConsiderationItems: 2,
          counter: '0'
        },
        signature: '0x0'
      },
      protocol_address: SEAPORT_1_6
    }

    const wethContract = new Contract(WETH_CONTRACT_ADDRESS, WETH_MIN_ABI, wallet);
    const OPENSEA_CONDUIT = "0x1e0049783f008a0085193e00003d00cd54003c71"

    await ensureAllowance(wethContract, wallet.address, offerPrice, OPENSEA_CONDUIT);

    // reset consideration list and count
    payload.protocol_data.parameters.consideration = [];
    payload.protocol_data.parameters.totalOriginalConsiderationItems = 2;

    // set correct slug for collection
    payload.criteria.collection.slug = slug;

    if (opensea_traits && typeof opensea_traits !== undefined) {
      payload.criteria.trait = JSON.parse(opensea_traits)
    } else {
      delete payload.criteria.trait
    }

    const buildPayload = {
      quantity: 1,
      criteria: payload.criteria,
      offerer: wallet_address,
      protocol_address: SEAPORT_1_6
    };

    try {
      const data = await buildOffer(buildPayload)
      if (!data || !data.partialParameters) return
      payload.protocol_data.parameters.startTime = BigInt(Math.floor(Date.now() / 1000)).toString();
      payload.protocol_data.parameters.endTime = BigInt(Math.floor(Date.now() / 1000 + expiry)).toString();
      payload.protocol_data.parameters.offerer = wallet_address;
      payload.protocol_data.parameters.offer[0].startAmount = offerPrice.toString();
      payload.protocol_data.parameters.offer[0].token = WETH_CONTRACT_ADDRESS;
      payload.protocol_data.parameters.offer[0].endAmount = offerPrice.toString();
      payload.protocol_data.parameters.consideration.push(data.partialParameters.consideration[0]);

      const opensea_consideration = {
        itemType: 1,
        token: WETH_CONTRACT_ADDRESS,
        identifierOrCriteria: 0,
        startAmount: offerPrice.mul(openseaFee).div(divider).toString(),
        endAmount: offerPrice.mul(openseaFee).div(divider).toString(),
        recipient: OPENSEA_FEE_ADDRESS
      };
      payload.protocol_data.parameters.consideration.push(opensea_consideration);

      for (const address in creator_fees) {
        let fee: BigNumber | number = creator_fees[address];
        fee = BigNumber.from(Math.round(fee).toString());
        if (enforceCreatorFee) {
          const consideration_item = {
            itemType: 1,
            token: WETH_CONTRACT_ADDRESS,
            identifierOrCriteria: 0,
            startAmount: offerPrice.mul(fee).div(divider).toString(),
            endAmount: offerPrice.mul(fee).div(divider).toString(),
            recipient: address
          };

          payload.protocol_data.parameters.consideration.push(consideration_item);
          payload.protocol_data.parameters.totalOriginalConsiderationItems += 1;
        }
      }

      payload.protocol_data.parameters.zone = data.partialParameters.zone;
      payload.protocol_data.parameters.zoneHash = data.partialParameters.zoneHash;
      payload.protocol_data.parameters.salt = BigInt(Math.floor(Math.random() * 100_000)).toString();

      const counter = await SEAPORT_CONTRACT.getCounter(wallet_address);

      payload.protocol_data.parameters.counter = counter.toString();

      const signObj = await wallet._signTypedData(
        domain,
        types,
        payload.protocol_data.parameters
      );

      payload.protocol_data.signature = signObj;
      payload.protocol_address = SEAPORT_1_6;

      await submitOfferToOpensea(payload, expiry, opensea_traits)
    } catch (error: any) {
      console.log("opensea error", error);
    }
  }
};


/**
 * Posts an offer to OpenSea.
 * @param payload - The payload of the offer.
 */
async function submitOfferToOpensea(payload: IPayload, expiry = 900, opensea_traits?: string) {
  try {
    const { data: offer } = await
      limiter.schedule(() => axiosInstance.request<OpenseaOffer>({
        method: 'POST',
        url: `https://api.nfttools.website/opensea/api/v2/offers`,
        headers: {
          'content-type': 'application/json',
          'X-NFT-API-Key': API_KEY
        },
        data: JSON.stringify(payload)
      }))

    const order_hash = offer.order_hash
    const trait = offer.criteria.trait?.type
      && offer.criteria.trait?.value
      ? `trait:${offer.criteria.trait?.type}:${offer.criteria.trait?.value}`
      : "default"

    const slug = offer.criteria.collection.slug
    const key = `opensea:order:${slug}:${trait}`;
    await redis.setex(key, expiry, order_hash);
    const successMessage = opensea_traits ?
      `🎉 TRAIT OFFER POSTED TO OPENSEA SUCCESSFULLY FOR: ${payload.criteria.collection.slug.toUpperCase()}  TRAIT: ${opensea_traits} 🎉`
      : `🎉 COLLECTION OFFER POSTED TO OPENSEA SUCCESSFULLY FOR: ${payload.criteria.collection.slug.toUpperCase()} 🎉`
    console.log(BLUE, successMessage, RESET);
  } catch (error: any) {
    console.log("opensea post offer error", error?.response?.data || error);

  }
}


/**
 * Builds an offer on OpenSea.
 * @param buildPayload - The payload to build the offer.
 */
async function buildOffer(buildPayload: any) {
  try {
    const { data } = await limiter.schedule(() =>
      axiosInstance.request<PartialParameters>({
        method: 'POST',
        url: `https://api.nfttools.website/opensea/api/v2/offers/build`,
        headers: {
          'content-type': 'application/json',
          'X-NFT-API-Key': API_KEY,
        },
        data: JSON.stringify(buildPayload),
      })
    );
    return data
  } catch (error: any) {
    console.log("opensea build offer error", error.response.data);
  }
}

export async function cancelOrder(orderHash: string, protocolAddress: string, privateKey: string) {

  const offererSignature = await signCancelOrder(orderHash, protocolAddress, privateKey);

  if (!offererSignature) {
    console.error("Failed to sign the cancel order.");
    return;
  }

  const url = `https://api.nfttools.website/opensea/api/v2/orders/chain/ethereum/protocol/${protocolAddress}/${orderHash}/cancel`;

  const headers = {
    'content-type': 'application/json',
    'X-NFT-API-Key': API_KEY
  };

  const body = {
    offerer_signature: offererSignature
  };

  try {
    const response = await axiosInstance.post(url, body, { headers });
    return response.data;
  } catch (error: any) {
    console.error("Error sending the cancel order request: ", error.response ? error.response.data : error.message);
    return null;
  }
}

async function signCancelOrder(orderHash: string, protocolAddress: string, privateKey: string) {

  const wallet = new Wallet(privateKey, provider);

  const domain = {
    name: 'Seaport',
    version: '1.6',
    chainId: '1',
    verifyingContract: protocolAddress
  };
  const types = {
    OrderHash: [
      { name: 'orderHash', type: 'bytes32' }
    ]
  };
  const value = {
    orderHash: orderHash
  };
  try {
    const signature = await wallet._signTypedData(domain, types, value);
    return signature;
  } catch (error) {
    console.error("Error signing the cancel order message: ", error);
    return null;
  }
}


async function signOffer(wallet: ethers.Wallet, offer: Record<string, unknown>) {
  return await wallet._signTypedData(domain, types, offer)
}

const getOffer = (priceWei: bigint) => {
  return [
    {
      itemType: 1, // ERC 20
      token: WETH_CONTRACT_ADDRESS,
      identifierOrCriteria: 0,
      startAmount: priceWei.toString(),
      endAmount: priceWei.toString(),
    },
  ]
}

async function postItemOffer(offer: unknown, signature: string) {

  try {
    const payload = {
      parameters: offer,
      signature,
      protocol_address: SEAPORT_CONTRACT_ADDRESS,
    }

    const { data } = await limiter.schedule(() => axiosInstance.post(`https://api.nfttools.website/opensea/api/v2/orders/ethereum/seaport/offers`, payload, {
      headers: {
        'content-type': 'application/json',
        'X-NFT-API-Key': API_KEY
      }
    }))

    return data
  } catch (error: any) {
    console.log(error.response.data);
  }
}


const getItemConsideration = async (
  assetContractAddress: string,
  tokenId: string,
  quantity: number,
  walletAddress: string

) => {
  const fees = [
    await getItemTokenConsideration(assetContractAddress, tokenId, quantity, walletAddress)
  ]
  return fees
}

const getSalt = () => {
  return Math.floor(Math.random() * 100_000).toString()
}

const getItemTokenConsideration = async (
  assetContractAddress: string,
  tokenId: string,
  quantity: number,
  walletAddress: string
) => {
  return {
    itemType: 2,
    token: assetContractAddress,
    identifierOrCriteria: tokenId,
    startAmount: quantity,
    endAmount: quantity,
    recipient: walletAddress,
  }
}

export async function fetchOpenseaOffers(
  address: string,
  offerType: 'COLLECTION' | 'TRAIT' | 'TOKEN',
  collectionSlug: string,
  contractAddress: string,
  identifiers: Record<string, string> | string
) {
  try {
    if (offerType === 'COLLECTION') {
      const url = `https://api.nfttools.website/opensea/api/v2/offers/collection/${collectionSlug}`;
      const { data } = await limiter.schedule(() => axiosInstance.get(url, {
        headers: {
          'accept': 'application/json',
          'X-NFT-API-Key': API_KEY
        }
      }));

      const filteredOffers = data.offers
        .filter((offer: any) => offer.protocol_data.parameters.offerer !== address.toLowerCase())
        .sort((a: any, b: any) => +b.price.value - +a.price.value);

      const bestOffer = filteredOffers[0];
      const offers = bestOffer.price.value;

      const quantity = bestOffer.protocol_data.parameters.consideration.find((item: any) => item.token.toLowerCase() === contractAddress.toLowerCase()).startAmount;

      return Number(offers) / Number(quantity);
    } else if (offerType === 'TRAIT') {
      const { type, value } = identifiers as Record<string, string>;
      const url = `https://api.nfttools.website/opensea/api/v2/offers/collection/${collectionSlug}/traits`;
      const { data } = await limiter.schedule(() => axiosInstance.get(url, {
        headers: {
          'accept': 'application/json',
          'X-NFT-API-Key': API_KEY
        },
        params: { type, value }
      }));

      const offers = data.offers?.filter((offer: any) => offer.protocol_data.parameters.offerer.toLowerCase() !== address.toLowerCase())
        .sort((a: any, b: any) => +b.price.value - +a.price.value)[0]?.price?.value || 0;
      return offers;
    } else if (offerType === 'TOKEN') {
      const token = identifiers as string;
      const url = `https://api.nfttools.website/opensea/api/v2/offers/collection/${collectionSlug}/nfts/${token}/best`;
      const { data } = await limiter.schedule(() => axiosInstance.get(url, {
        headers: {
          'accept': 'application/json',
          'X-NFT-API-Key': API_KEY
        }
      }))

      const quantity = data?.protocol_data?.parameters?.consideration?.find((item: any) => item.token.toLowerCase() === contractAddress.toLowerCase()).startAmount ?? 1
      return Number(data.price.value) / Number(quantity);
    } else {
      throw new Error("Invalid offer type");
    }
  } catch (error: any) {
    console.error(RED + "Error fetching offers:", error?.response?.data?.message?.errors[0] || JSON.stringify(error.response.data.message) + RESET);
  }
}


interface Price {
  currency: string;
  decimals: number;
  value: string;
}

interface Collection {
  slug: string;
}

interface Address {
  address: string;
}

interface Trait {
  type?: string;
  value?: string;
}

interface Criteria {
  collection: Collection;
  contract: Address;
  trait: Trait | null;
  encoded_token_ids: any; // Adjust type as necessary
}

interface OfferItem {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
}

interface ConsiderationItem {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
  recipient: string;
}

interface Parameters {
  offerer: string;
  offer: OfferItem[];
  consideration: ConsiderationItem[];
  startTime: string;
  endTime: string;
  orderType: number;
  zone: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  totalOriginalConsiderationItems: number;
  counter: number;
}

interface ProtocolData {
  parameters: Parameters;
  signature: string;
}

interface OpenseaOffer {
  order_hash: string;
  chain: string;
  price: Price;
  criteria: Criteria;
  protocol_data: ProtocolData;
  protocol_address: string;
}


export interface IFee {
  [address: string]: number;
}

interface IPayload {
  criteria: ICriteria;
  protocol_data: IProtocolData;
  protocol_address: string;
  [key: string]: any; // Allow additional properties
}

interface ICriteria {
  collection: {
    slug: string;
  };
  trait?: any; // Optional trait, can be more specific if needed
  [key: string]: any; // Allow additional properties
}


interface IProtocolData {
  parameters: {
    offerer: string;
    offer: IOfferItem[];
    consideration: IConsiderationItem[];
    startTime: string;
    endTime: string;
    orderType: number;
    zone: string;
    zoneHash: string;
    conduitKey: string;
    totalOriginalConsiderationItems: number;
    counter: string;
    [key: string]: any; // Allow additional properties
  };
  signature: string;
  [key: string]: any; // Allow additional properties
}

interface IOfferItem {
  itemType: number;
  token: string;
  identifierOrCriteria: number;
  startAmount: string;
  endAmount: string;
  [key: string]: any; // Allow additional properties
}

interface IConsiderationItem {
  itemType: number;
  token: string;
  identifierOrCriteria: number;
  startAmount: string;
  endAmount: string;
  recipient: string;
  [key: string]: any; // Allow additional properties
}

interface PartialParameters {
  consideration: Array<{
    itemType: number;
    token: string;
    identifierOrCriteria: string;
    startAmount: string;
    endAmount: string;
    recipient: string;
    [key: string]: any; // Allow additional properties
  }>;
  zone: string;
  zoneHash: string;
  [key: string]: any; // Allow additional properties
}

interface ItemOfferSpecification {
  assetContractAddress: string
  tokenId: string
  quantity: number
  priceWei: bigint
  expirationSeconds: bigint
  walletAddress: string
}