import { BigNumber, Contract, ethers, Wallet } from "ethers";
import { SEAPORT_CONTRACT_ADDRESS, SEAPORT_MIN_ABI, WETH_CONTRACT_ADDRESS, WETH_MIN_ABI } from "../../constants";
import { API_KEY, axiosInstance, limiter } from "../../init";
import { ensureAllowance } from "../../functions";
import { BLUE, RESET } from "../..";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY
const provider = new ethers.providers.AlchemyProvider('mainnet', ALCHEMY_API_KEY);
const SEAPORT_CONTRACT = new ethers.Contract(SEAPORT_CONTRACT_ADDRESS, SEAPORT_MIN_ABI, provider);

const domain = {
  name: 'Seaport',
  version: '1.6',
  chainId: '1',
  verifyingContract: '0x0000000000000068f116a894984e2db1123eb395'
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

/**
 * Creates an offer on OpenSea.
 * @param walletAddress - The wallet address of the offerer.
 * @param privateKey - The private key of the offerer's wallet.
 * @param slug - The slug of the collection.
 * @param offerPrice - The price of the offer in wei.
 * @param creatorFees - The fees for the creators.
 * @param enforceCreatorFee - Whether to enforce creator fees.
 * @param openseaTraits - Optional traits for the offer.
 */
export async function bidOnOpensea(
  wallet_address: string,
  private_key: string,
  slug: string,
  offer_price: bigint,
  creator_fees: IFee,
  enforceCreatorFee: boolean,
  opensea_traits?: string
) {
  const divider = BigNumber.from(10000);
  const roundedNumber = Math.round(Number(offer_price) / 1e14) * 1e14;
  const offerPrice = BigNumber.from(roundedNumber.toString());
  const openseaFee = BigNumber.from(250);

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
            token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            identifierOrCriteria: 0,
            startAmount: (Date.now() / 1000).toString(),
            endAmount: (Date.now() / 1000 + 100000).toString()
          }
        ],
        consideration: [],
        startTime: '1666480886',
        endTime: '1666680886',
        orderType: 2,
        zone: '0x004C00500000aD104D7DBd00e3ae0A5C00560C00',
        zoneHash:
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        conduitKey:
          '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
        totalOriginalConsiderationItems: 2,
        counter: '0'
      },
      signature: '0x0'
    },
    protocol_address: '0x0000000000000068f116a894984e2db1123eb395'
  }

  const wallet = new Wallet(private_key, provider);
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
    protocol_address: '0x0000000000000068f116a894984e2db1123eb395'
  };

  try {
    const data = await buildOffer(buildPayload)
    payload.protocol_data.parameters.startTime = BigInt(Math.floor(Date.now() / 1000)).toString();
    payload.protocol_data.parameters.endTime = BigInt(Math.floor(Date.now() / 1000 + 900)).toString();
    payload.protocol_data.parameters.offerer = wallet_address;
    payload.protocol_data.parameters.offer[0].startAmount = offerPrice.toString();
    payload.protocol_data.parameters.offer[0].token = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    payload.protocol_data.parameters.offer[0].endAmount = offerPrice.toString();
    payload.protocol_data.parameters.consideration.push(data.partialParameters.consideration[0]);

    const opensea_consideration = {
      itemType: 1,
      token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      identifierOrCriteria: 0,
      startAmount: offerPrice.mul(openseaFee).div(divider).toString(),
      endAmount: offerPrice.mul(openseaFee).div(divider).toString(),
      recipient: '0x0000a26b00c1F0DF003000390027140000fAa719'
    };
    payload.protocol_data.parameters.consideration.push(opensea_consideration);

    for (const address in creator_fees) {
      let fee: BigNumber | number = creator_fees[address];
      fee = BigNumber.from(Math.round(fee).toString());
      if (enforceCreatorFee) {
        const consideration_item = {
          itemType: 1,
          token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
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
    payload.protocol_address = '0x0000000000000068f116a894984e2db1123eb395';

    await submitOfferToOpensea(payload, opensea_traits)
  } catch (error: any) {
    console.log("opensea error", error);
  }
};


/**
 * Posts an offer to OpenSea.
 * @param payload - The payload of the offer.
 */
async function submitOfferToOpensea(payload: IPayload, opensea_traits?: string) {
  try {
    await
      limiter.schedule(() => axiosInstance.request({
        method: 'POST',
        url: `https://api.nfttools.website/opensea/api/v2/offers`,
        headers: {
          'content-type': 'application/json',
          'X-NFT-API-Key': API_KEY
        },
        data: JSON.stringify(payload)
      }))

    const successMessage = opensea_traits ?
      `🎉 TRAIT OFFER POSTED TO OPENSEA SUCCESSFULLY FOR: ${payload.criteria.collection.slug.toUpperCase()}  TRAIT: ${opensea_traits}🎉`
      : `🎉 OFFER POSTED TO OPENSEA SUCCESSFULLY FOR: ${payload.criteria.collection.slug.toUpperCase()} 🎉`
    console.log(BLUE, successMessage, RESET);
  } catch (error: any) {
    console.log("opensea post offer error", error.response.data);

  }
}


/**
 * Builds an offer on OpenSea.
 * @param buildPayload - The payload to build the offer.
 */
async function buildOffer(buildPayload: any) {
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
