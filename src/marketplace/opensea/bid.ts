import { BigNumber, Contract, ethers, Wallet } from "ethers";
import { SEAPORT_CONTRACT_ADDRESS, SEAPORT_MIN_ABI, WETH_MIN_ABI } from "../../constants";
import { axiosInstance, limiter, RATE_LIMIT } from "../../init";
import { BLUE, currentTasks, OPENSEA_SCHEDULE, OPENSEA_TOKEN_BID, OPENSEA_TRAIT_BID, queue } from "../..";
import redisClient from "../../utils/redis";
import { config } from "dotenv";
import { createBalanceChecker } from "../../utils/balance";

config()

const OPENSEA_PROTOCOL_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395"
const API_KEY = process.env.API_KEY as string;
const OPENSEA_ITEM_ZONE = "0x000056f7000000ece9003ca63978907a00ffd100"
const OPENSEA_COLLECTION_ZONE = "0x004C00500000aD104D7DBd00e3ae0A5C00560C00"
const ZONE_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000"
const CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000"
const SEAPORT_1_6 = "0x0000000000000068f116a894984e2db1123eb395"
const WETH_CONTRACT_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
const OPENSEA_FEE_ADDRESS = "0x0000a26b00c1F0DF003000390027140000fAa719"
const ALCHEMY_API_KEY = "0rk2kbu11E5PDyaUqX1JjrNKwG7s4ty5"
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


const deps = {
  redis: redis,
  provider: new ethers.providers.AlchemyProvider("mainnet", ALCHEMY_API_KEY),
};

const balanceChecker = createBalanceChecker(deps);


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
    const task = currentTasks.find((task) => task.contract.contractAddress.toLowerCase() === offerSpecification.assetContractAddress.toLowerCase() && task.selectedMarketplaces.includes("OpenSea"))
    if (!task?.running) return

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
  bidCount: number,
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
  const task = currentTasks.find((task) => task.contract.slug.toLowerCase() === slug.toLowerCase() && task.selectedMarketplaces.includes("OpenSea"))
  if (!task?.running) return
  const divider = BigNumber.from(10000);
  const roundedNumber = Math.round(Number(offer_price) / 1e14) * 1e14;
  const offerPrice = BigNumber.from(roundedNumber.toString());

  const offerPriceEth = Number(offer_price) / 1e18
  const wethBalance = await balanceChecker.getWethBalance(wallet_address);
  const pattern = `*:opensea:${slug}:*`
  const keys = await redis.keys(pattern)
  let totalExistingOffers = 0
  const bidLimit = 1000

  if (keys.length > 0) {
    const values = await redis.mget(keys)
    totalExistingOffers = values.reduce((sum, value) =>
      sum + (value ? Number(value) : 0), 0)
  }

  const totalOffersWithNew = totalExistingOffers / 1e18 + Number(offerPriceEth)
  if (totalOffersWithNew > wethBalance * bidLimit) {
    console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
    console.log(RED + `Total offers (${totalOffersWithNew} WETH) would exceed 1000x available BETH balance (${wethBalance * 1000} WETH). SKIPPING ...`.toUpperCase() + RESET);
    console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);

    // Remove all OpenSea jobs from the queue
    const jobs = await queue.getJobs(['waiting', 'delayed', 'failed', 'paused', 'prioritized', 'repeat', 'wait', 'waiting', 'waiting-children']);
    const openseaJobs = jobs.filter(job =>
      [OPENSEA_SCHEDULE, OPENSEA_TRAIT_BID, OPENSEA_TOKEN_BID].includes(job?.name) &&
      !job?.lockKey // Only include jobs that aren't locked by a worker
    );

    if (openseaJobs.length > 0) {
      const results = await Promise.allSettled(openseaJobs.map(job => job.remove()));
      const removedCount = results.filter(result => result.status === 'fulfilled').length;
      const failedCount = results.filter(result => result.status === 'rejected').length;

      console.log(RED + `Removed ${removedCount} OpenSea jobs from queue due to insufficient WETH balance (${failedCount} failed)` + RESET);
    }

    return
  }

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
    const baseKey = `opensea:order:${slug}:${asset.tokenId}`;

    const key = `${bidCount}:${baseKey}`;
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

      const task = currentTasks.find((task) => task.contract.slug.toLowerCase() === slug.toLowerCase() && task.selectedMarketplaces.includes("OpenSea"))
      if (!task?.running) return

      await submitOfferToOpensea(private_key, slug, bidCount, payload, expiry, opensea_traits)
    } catch (error: any) {
      console.log("opensea error", error);
    }
  }
};


/**
 * Posts an offer to OpenSea.
 * @param payload - The payload of the offer.
 */
async function submitOfferToOpensea(privateKey: string, slug: string, bidCount: number, payload: IPayload, expiry = 900, opensea_traits?: string) {
  let task = currentTasks.find((task) => task.contract.slug.toLowerCase() === slug.toLowerCase() || task.selectedMarketplaces.includes("OpenSea"))
  if (!task?.running) return
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
    const trait = offer?.criteria?.trait?.type
      && offer?.criteria?.trait?.value
      ? `trait:${offer.criteria.trait?.type}:${offer.criteria.trait?.value}`
      : "default"


    const slug = offer?.criteria?.collection?.slug
    const baseKey = `opensea:order:${slug}:${trait}`;
    const key = `${bidCount}:${baseKey}`;
    await redis.setex(key, expiry, order_hash);

    const successMessage = opensea_traits ?
      `🎉 TRAIT OFFER POSTED TO OPENSEA SUCCESSFULLY FOR: ${payload.criteria.collection.slug.toUpperCase()}  TRAIT: ${opensea_traits} 🎉`
      : `🎉 COLLECTION OFFER POSTED TO OPENSEA SUCCESSFULLY FOR: ${payload.criteria.collection.slug.toUpperCase()} 🎉`
    console.log(BLUE, successMessage, RESET);

    task = currentTasks.find((task) => task?.contract?.slug.toLowerCase() === slug?.toLowerCase() && task?.selectedMarketplaces.includes("OpenSea"))
    if (!task?.running) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await cancelOrder(order_hash, OPENSEA_PROTOCOL_ADDRESS, privateKey)
    }
  } catch (error: any) {
    if (error?.response?.data?.message?.errors?.[0] === 'Outstanding order to wallet balance ratio exceeds allowed limit.' ||
      error?.message?.errors?.[0] === 'Outstanding order to wallet balance ratio exceeds allowed limit.' ||
      error?.response?.data?.message === 'Outstanding order to wallet balance ratio exceeds allowed limit.' ||
      error?.message === 'Outstanding order to wallet balance ratio exceeds allowed limit.') {
      // Remove all OpenSea jobs from the queue
      const jobs = await queue.getJobs(['waiting', 'delayed', 'failed', 'paused', 'prioritized', 'repeat', 'wait', 'waiting', 'waiting-children']);
      const openseaJobs = jobs.filter(job =>
        [OPENSEA_SCHEDULE, OPENSEA_TRAIT_BID, OPENSEA_TOKEN_BID].includes(job?.name) &&
        !job?.lockKey // Only include jobs that aren't locked by a worker
      );

      if (openseaJobs.length > 0) {
        const results = await Promise.allSettled(openseaJobs.map(job => job.remove()));
        const removedCount = results.filter(result => result.status === 'fulfilled').length;
        const failedCount = results.filter(result => result.status === 'rejected').length;

        console.log(RED + `Removed ${removedCount} OpenSea jobs from queue due to insufficient WETH balance (${failedCount} failed)` + RESET);
      }
    } else {
      console.log("opensea post offer error", error?.response?.data || error?.message || error);
    }
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
  if (!orderHash || !protocolAddress || !privateKey) return
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
    const response = await limiter.schedule(() => axiosInstance.post(url, body, { headers }))
    console.log(JSON.stringify({ cancelled: true }));
    return response.data;
  } catch (error: any) {
    // console.error("Error sending the cancel order request: ", error.response ? error.response.data : error.message);
    return null;
  }
}

async function signCancelOrder(orderHash: string, protocolAddress: string, privateKey: string) {
  if (!orderHash) return

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
    console.error("Error signing the cancel order message for order hash:", orderHash, error);
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

    if (error?.response?.data?.message?.errors?.[0] === 'Outstanding order to wallet balance ratio exceeds allowed limit.' ||
      error?.message?.errors?.[0] === 'Outstanding order to wallet balance ratio exceeds allowed limit.' ||
      error?.response?.data?.message === 'Outstanding order to wallet balance ratio exceeds allowed limit.' ||
      error?.message === 'Outstanding order to wallet balance ratio exceeds allowed limit.') {
      const jobs = await queue.getJobs(['waiting', 'delayed', 'failed', 'paused', 'prioritized', 'repeat', 'wait', 'waiting', 'waiting-children']);
      const openseaJobs = jobs.filter(job =>
        [OPENSEA_SCHEDULE, OPENSEA_TRAIT_BID, OPENSEA_TOKEN_BID].includes(job?.name) &&
        !job?.lockKey
      );

      if (openseaJobs.length > 0) {
        const results = await Promise.allSettled(openseaJobs.map(job => job.remove()));
        const removedCount = results.filter(result => result.status === 'fulfilled').length;
        const failedCount = results.filter(result => result.status === 'rejected').length;

        console.log(RED + `Removed ${removedCount} OpenSea jobs from queue due to insufficient WETH balance (${failedCount} failed)` + RESET);
      }
    } else {
      console.log("opensea post item offer error", error?.response?.data || error?.message || error);
    }
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
    console.error(RED + "Error fetching offers:",
      error?.response?.data?.message?.errors && error.response.data.message.errors.length > 0
        ? error.response.data.message.errors[0]
        : JSON.stringify(error.response.data.message) + RESET);
  }
}


export async function fetchOpenseaListings(collectionSlug: string, limit?: number) {
  try {
    const baseUrl = `https://api.nfttools.website/opensea/api/v2/listings/collection/${collectionSlug}/all`;
    let allListings: OpenseaOrder[] = [];
    let nextCursor: string | null = null;

    if (!limit) return

    while (allListings.length < limit) {
      const params: any = {
        next: nextCursor,
        limit: Math.min(100, limit - allListings.length)
      }
      const { data } = await limiter.schedule(() => axiosInstance.get<OpenseaListingData>(baseUrl, {
        headers: {
          'accept': 'application/json',
          'X-NFT-API-Key': API_KEY
        },
        params: params
      }))
      allListings = [...allListings, ...data.listings];
      nextCursor = data.next;
      if (!nextCursor) break;
    }
    allListings = allListings.slice(0, limit);
    return allListings.map((item) => +item.protocol_data.parameters.offer[0].identifierOrCriteria)
  } catch (error: any) {
    console.error("Error fetching listings:", error?.response?.data?.message || error.message);
    throw error;
  }
}

interface OpenseaListingData {
  listings: OpenseaOrder[]
  next: string
}

interface OpenseaOrder {
  order_hash: string;
  chain: string;
  type: string;
  price: OpenseaPrice;
  protocol_data: OpenseaProtocolData;
  protocol_address: string;
}

interface OpenseaPrice {
  current: OpenseaPriceCurrent;
}

interface OpenseaPriceCurrent {
  currency: string;
  decimals: number;
  value: string;
}

interface OpenseaProtocolData {
  parameters: OpenseaParameters;
  signature: null;
}

interface OpenseaParameters {
  offerer: string;
  offer: OpenseaOffer[];
  consideration: OpenseaConsideration[];
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

interface OpenseaOffer {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
}

interface OpenseaConsideration {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
  recipient: string;
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
