import { config } from "dotenv";
import { axiosInstance, limiter } from "../init"; // Import Redis client
import redisClient from "../utils/redis";
import { DistributedLockManager } from "../utils/lock";

config()

const API_KEY = process.env.API_KEY as string

const redis = redisClient.getClient()

const collectionCache: { [key: string]: any } = {};
const MAX_CACHE_ITEMS = 1000;
const lockManager = new DistributedLockManager(redis);

export async function getCollectionDetails(slug: string) {
  // First check memory cache
  if (collectionCache[slug]) {
    return collectionCache[slug];
  }

  // Try to get with lock
  const lockKey = `collection:${slug}`;
  const result = await lockManager.withLock(lockKey, async () => {
    // Double-check cache after acquiring lock
    if (collectionCache[slug]) {
      return collectionCache[slug];
    }

    try {
      const { data: collection } = await limiter.schedule(() => axiosInstance
        .get(
          `https://api.nfttools.website/opensea/api/v2/collections/${slug}`,
          {
            headers: {
              'X-NFT-API-Key': API_KEY
            }
          }
        ));

      // Add validation for collection data
      if (!collection || !collection.editors || !collection.contracts) {
        throw new Error('Invalid collection data received from API');
      }

      let creator_fees;
      let enforceCreatorFee = false;
      if (collection?.fees?.length > 1) {
        creator_fees = {
          [collection.fees[1].recipient]: collection.fees[1].fee * 100
        };
        enforceCreatorFee = collection.fees[1].required;
      } else {
        creator_fees = { null: 0 }
      }

      if (Object.keys(collectionCache).length >= MAX_CACHE_ITEMS) {
        delete collectionCache[Object.keys(collectionCache)[0]];
      }

      const result = {
        address: collection.editors[0],
        primary_asset_contracts_address: collection.contracts[0].address,
        creator_fees: creator_fees,
        enforceCreatorFee: enforceCreatorFee,
        ...collection
      };

      collectionCache[slug] = result;
      return result;
    } catch (error: any) {
      // Improved error logging
      console.error('Error fetching collection details:', {
        slug,
        error: error?.response?.data || error.message || error
      });

      // Rethrow with a more specific message
      throw new Error(`Failed to fetch collection details for ${slug}: ${error?.response?.data?.message || error.message || 'Unknown error'}`);
    }
  });

  if (!result) {
    throw new Error('Failed to acquire lock for collection details');
  }

  return result;
}

export async function getCollectionStats(collectionSlug: string) {
  const cacheKey = `collectionStats:${collectionSlug}`;
  const cachedData = await redis.get(cacheKey);
  if (cachedData) {
    return JSON.parse(cachedData);
  }

  const lockKey = `collectionStats:lock:${collectionSlug}`;
  const result = await lockManager.withLock(lockKey, async () => {
    // Double-check cache after acquiring lock
    const cachedDataAfterLock = await redis.get(cacheKey);
    if (cachedDataAfterLock) {
      return JSON.parse(cachedDataAfterLock);
    }

    const { data } = await limiter.schedule(() => axiosInstance.get<CollectionStats>(
      `https://api.nfttools.website/opensea/api/v2/collections/${collectionSlug}/stats`,
      {
        headers: { 'X-NFT-API-Key': API_KEY }
      }
    ));

    await redis.setex(cacheKey, 30, JSON.stringify(data));
    return data;
  });

  if (!result) {
    throw new Error('Failed to acquire lock for collection stats');
  }

  return result;
}

export async function getCollectionEvents(
  collectionSlug: string,
  eventTypes: string[] = ['all', 'cancel', 'listing', 'offer', 'order', 'sale', 'transfer'],
  limit: number = 50
) {
  const cacheKey = `collectionEvents:${collectionSlug}:${eventTypes.join(',')}:${limit}`;
  const cachedData = await redis.get(cacheKey);
  if (cachedData) {
    return JSON.parse(cachedData);
  }

  try {
    const params = new URLSearchParams();
    eventTypes.forEach(type => params.append('event_type', type));
    params.append('limit', limit.toString());

    const { data } = await limiter.schedule(() => axiosInstance.get<CollectionEventResponse>(
      `https://api.nfttools.website/opensea/api/v2/events/collection/${collectionSlug}`,
      {
        params: params,
        headers: { 'X-NFT-API-Key': API_KEY }
      }
    ));

    // Cache for a short period (e.g., 30 seconds) since events data changes frequently
    await redis.setex(cacheKey, 10, JSON.stringify(data));
    return data;
  } catch (error) {
    console.error('Error fetching collection events:', error);
    throw error;
  }
}


interface CollectionStats {
  total: {
    volume: number;
    sales: number;
    average_price: number;
    num_owners: number;
    market_cap: number;
    floor_price: number;
    floor_price_symbol: string;
  };
  intervals: {
    interval: string;
    volume: number;
    volume_diff: number;
    volume_change: number;
    sales: number;
    sales_diff: number;
    average_price: number;
  }[];
}

interface CollectionEventResponse {
  asset_events: AssetEvent[];
  next: string;
}

interface AssetEvent {
  event_type: string;
  order_hash: string;
  order_type: string;
  chain: string;
  protocol_address: string;
  start_date: number;
  expiration_date: number;
  asset: null;
  quantity: number;
  maker: string;
  taker: string;
  payment: Payment;
  criteria: Criteria;
  event_timestamp: number;
  is_private_listing: boolean;
}

interface Payment {
  quantity: string;
  token_address: string;
  decimals: number;
  symbol: string;
}

interface Criteria {
  collection: {
    slug: string;
  };
  contract: {
    address: string;
  };
  trait: null;
  encoded_token_ids: null;
}