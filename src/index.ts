import express from "express";
import { config } from "dotenv";
import bodyParser from "body-parser";
import cors from "cors";
import WebSocket, { Server as WebSocketServer } from 'ws';
import http from 'http';
import { initialize } from "./init";
import { bidOnOpensea, cancelOrder, IFee } from "./marketplace/opensea";
import { bidOnBlur, cancelBlurBid } from "./marketplace/blur/bid";
import { bidOnMagiceden, canelMagicEdenBid } from "./marketplace/magiceden";
import { getCollectionDetails, getCollectionStats } from "./functions";
import mongoose from 'mongoose';
import Task from "./models/task.model";
import { Queue, Worker } from "bullmq";
import Wallet from "./models/wallet.model";
import redisClient from "./utils/redis";

const redis = redisClient.getClient()

config()
export const MAGENTA = '\x1b[35m';
export const BLUE = '\x1b[34m';
export const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

const currentTasks: ITask[] = [];
const QUEUE_NAME = 'BIDDING_BOT';
const OPENSEA_COUNTERBID = "OPENSEA_COUNTERBID"
const UPDATE_STATUS = "UPDATE_STATUS"

const OPENSEA_SCHEDULE = "OPENSEA_SCHEDULE"
const OPENSEA_TRAIT_BID = "OPENSEA_TRAIT_BID"
const BLUR_TRAIT_BID = "BLUR_TRAIT_BID"
const BLUR_SCHEDULE = "BLUR_SCHEDULE"
const MAGICEDEN_SCHEDULE = "MAGICEDEN_SCHEDULE"
const MAGICEDEN_TOKEN_BID = "MAGICEDEN_TOKEN_BID"
const OPENSEA_TOKEN_BID = "OPENSEA_TOKEN_BID"
const MAGICEDEN_TRAIT_BID = "MAGICEDEN_TRAIT_BID"

const CANCEL_OPENSEA_BID = "CANCEL_OPENSEA_BID"
const CANCEL_MAGICEDEN_BID = "CANCEL_MAGICEDEN_BID"
const CANCEL_BLUR_BID = "CANCEL_BLUR_BID"
const START_TASK = "START_TASK"
const STOP_TASK = "STOP_TASK"

const MAX_RETRIES: number = 5;
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const OPENSEA_WS_URL = `wss://stream.openseabeta.com/socket/websocket?token=${OPENSEA_API_KEY}`;
const RATE_LIMIT = 30;
const MAX_WAITING_QUEUE = 10 * RATE_LIMIT;
const OPENSEA_PROTOCOL_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395"

const itemLocks = new Map();

// create queue
const queue = new Queue(QUEUE_NAME);

const app = express();
const port = process.env.PORT || 3003;

app.use(bodyParser.json());
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
let ws: WebSocket;
let heartbeatIntervalId: NodeJS.Timeout | null = null;
let reconnectTimeoutId: NodeJS.Timeout | null = null;
let retryCount: number = 0;
let waitingQueueCount = 0;

const walletsArr: string[] = []

async function fetchCurrentTasks() {
  try {
    const tasks = await Task.find({}).lean().exec() as unknown as ITask[];
    const wallets = (await Wallet.find({}).lean()).map((wallet: any) => wallet.address);
    walletsArr.push(...wallets);

    const formattedTasks = tasks.map((task) => ({ ...task, _id: task._id.toString(), user: task.user.toString() }));

    const jobs = formattedTasks.flatMap(task =>
      task.running && task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea") ? [{ name: OPENSEA_SCHEDULE, data: task }] : []
    ).concat(
      formattedTasks.flatMap(task =>
        task.running && task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur") ? [{ name: BLUR_SCHEDULE, data: task }] : []
      )
    ).concat(
      formattedTasks.flatMap(task =>
        task.running && task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden") ? [{ name: MAGICEDEN_SCHEDULE, data: task }] : []
      )
    );

    await queue.addBulk(jobs);
    currentTasks.push(...formattedTasks);
    console.log(`Fetched ${formattedTasks.length} current tasks from the database.`);
  } catch (error) {
    console.error('Error fetching current tasks:', error);
  }
}

async function startServer() {
  try {
    await initialize();
    await mongoose.connect(process.env.MONGODB_URI as string);
    console.log('Connected to MongoDB');

    server.listen(port, () => {
      console.log(`Magic happening on http://localhost:${port}`);
      console.log(`WebSocket server is running on ws://localhost:${port}`);
    });

    await fetchCurrentTasks();

  } catch (error) {
    console.error(RED + 'Failed to connect to MongoDB:' + RESET, error);
  }
}

startServer().catch(error => {
  console.error('Failed to start server:', error);
});

connectWebSocket()

wss.on('connection', (ws) => {
  console.log(GREEN + 'New WebSocket connection' + RESET);
  ws.onmessage = async (event: WebSocket.MessageEvent) => {
    try {
      const message = JSON.parse(event.data as string);
      switch (message.endpoint) {
        case 'new-task':
          await processNewTask(message.data);
          break;
        case 'updated-task':
          await processUpdatedTask(message.data);
          break;
        case 'toggle-status':
          await updateStatus(message.data);
          break;
        case 'update-multiple-tasks-status':
          await updateMultipleTasksStatus(message.data);
          break;
        case 'update-marketplace':
          await updateMarketplace(message.data)
          break
        default:
          console.warn(YELLOW + `Unknown endpoint: ${message.endpoint}` + RESET);
      }
    } catch (error) {
      console.error(RED + 'Error handling WebSocket message:' + RESET, error);
    }
  };

  ws.onclose = () => {
    console.log(YELLOW + 'WebSocket connection closed' + RESET);
  };
});



const worker = new Worker(QUEUE_NAME, async (job) => {
  const itemId = job.data.itemId;
  await waitForUnlock(itemId, job.name);
  try {
    itemLocks.set(itemId, true);
    switch (job.name) {
      case OPENSEA_COUNTERBID:
        await processOpenseaCounterBid(job.data)
        break;
      case OPENSEA_SCHEDULE:
        await processOpenseaScheduledBid(job.data)
        break;
      case OPENSEA_TRAIT_BID:
        await processOpenseaTraitBid(job.data)
        break;
      case OPENSEA_TOKEN_BID:
        await processOpenseaTokenBid(job.data)
        break;
      case BLUR_SCHEDULE:
        await processBlurScheduledBid(job.data)
        break;
      case BLUR_TRAIT_BID:
        await processBlurTraitBid(job.data)
        break;
      case MAGICEDEN_SCHEDULE:
        await processMagicedenScheduledBid(job.data)
        break;
      case MAGICEDEN_TRAIT_BID:
        await processMagicedenTraitBid(job.data)
        break;
      case MAGICEDEN_TOKEN_BID:
        await processMagicedeTokenBid(job.data)
        break;
      case CANCEL_OPENSEA_BID:
        await bulkCancelOpenseaBid(job.data)
        break;
      case CANCEL_MAGICEDEN_BID:
        await bulkCancelMagicedenBid(job.data)
        break;
      case CANCEL_BLUR_BID:
        await blukCancelBlurBid(job.data)
        break;
      case UPDATE_STATUS:
        await updateStatus(job.data)
        break
      case START_TASK:
        await startTask(job.data, true)
        break
      case STOP_TASK:
        await stopTask(job.data, false)
        break
      default:
        console.log(`Unknown job type: ${job.name}`);
    }
  } finally {
    itemLocks.delete(itemId);
  }
},
  {
    connection: redis,
    concurrency: RATE_LIMIT,
  },
);


async function processNewTask(task: ITask) {
  try {
    currentTasks.push(task);
    console.log(GREEN + `Added new task: ${task.contract.slug}` + RESET);
    const jobs = await queue.addBulk([
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea") ? [{ name: OPENSEA_SCHEDULE, data: task }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur") ? [{ name: BLUR_SCHEDULE, data: task }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden") ? [{ name: MAGICEDEN_SCHEDULE, data: task }] : []),
    ]);
    console.log(`Successfully added ${jobs.length} jobs to the queue.`);
    subscribeToCollections([task]);
  } catch (error) {
    console.error(RED + `Error processing new task: ${task.contract.slug}` + RESET, error);
  }
}

async function processUpdatedTask(task: ITask) {
  try {
    const existingTaskIndex = currentTasks.findIndex(t => t._id === task._id);
    if (existingTaskIndex !== -1) {
      currentTasks.splice(existingTaskIndex, 1, task);
      console.log(YELLOW + `Updated existing task: ${task.contract.slug}` + RESET);
      subscribeToCollections([task]);
    } else {
      console.log(RED + `Attempted to update non-existent task: ${task.contract.slug}` + RESET);
    }
  } catch (error) {
    console.error(RED + `Error processing updated task: ${task.contract.slug}` + RESET, error);
  }
}

const taskCache = new Map<string, { WALLET_ADDRESS: string, WALLET_PRIVATE_KEY: string }>();

async function startTask(task: ITask, start: boolean) {
  try {
    const taskIndex = currentTasks.findIndex(task => task._id === task._id);

    if (taskIndex !== -1) {
      currentTasks[taskIndex].running = start;
    }
    console.log(GREEN + `Updated task ${task.contract.slug} running status to: ${start}`.toUpperCase() + RESET);
    if (task.outbidOptions.counterbid) {
      subscribeToCollections([currentTasks[taskIndex]]);
    }

    const jobs = [
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea") ? [{ name: OPENSEA_SCHEDULE, data: { ...task, running: start } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur") ? [{ name: BLUR_SCHEDULE, data: { ...task, running: start } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden") ? [{ name: MAGICEDEN_SCHEDULE, data: { ...task, running: start } }] : []),
    ]

    await queue.addBulk(jobs);
  } catch (error) {
    console.log(error);
  }
}

async function stopTask(task: ITask, start: boolean) {
  try {
    const taskIndex = currentTasks.findIndex(task => task._id === task._id);
    if (taskIndex !== -1) {
      currentTasks[taskIndex].running = start;
    }
    console.log(YELLOW + `Stopped processing task ${task.contract.slug}` + RESET);

    const jobs = await queue.getJobs(['waiting', 'completed', 'failed', "delayed", "paused"]);

    const stoppedJob = jobs.filter((job) => job.data.slug === task.contract.slug || job.data?.contract?.slug === task?.contract?.slug);
    await Promise.all(stoppedJob.map(job => job.remove()));

    const openseaBids = await redis.keys(`opensea:order:${task.contract.slug}:*`);
    const openseaBidData = await Promise.all(openseaBids.map(key => redis.get(key)));
    const cancelData = openseaBidData.map(bid => ({ name: CANCEL_OPENSEA_BID, data: { orderHash: bid, privateKey: task.wallet.privateKey } }));
    const magicedenBids = await redis.keys(`magiceden:order:${task.contract.slug}:*`);
    const magicedenBidData = await Promise.all(magicedenBids.map(key => redis.get(key)));
    const parsedMagicedenBid = magicedenBidData
      .filter(data => data !== null) // Ensure data is not null
      .map((data) => JSON.parse(data))
      .filter((data) => data?.message?.toLowerCase() === "success")
      .map((data) => data.orderId)

    const blurBids = await redis.keys(`blur:order:${task.contract.slug}:*`)
    const blurBidData = await Promise.all(blurBids.map(key => redis.get(key)));
    const parsedBlurBid = blurBidData
      .filter(data => data !== null) // Ensure data is not null
      .map((data) => JSON.parse(data))

    const blurCancelData = parsedBlurBid.map((bid) => ({ name: CANCEL_BLUR_BID, data: { payload: bid, privateKey: task.wallet.privateKey } }))
    await queue.addBulk(cancelData);

    queue.add(CANCEL_MAGICEDEN_BID, { orderIds: parsedMagicedenBid, privateKey: task.wallet.privateKey })
    await queue.addBulk(blurCancelData)
    const count = parsedMagicedenBid.length + cancelData.length + blurCancelData.length;
    console.log(`Successfully added ${count} bid cancel jobs to the queue. ${task.contract.slug}`);

    // await Promise.all(openseaBids.map(key => redis.del(key)));
    // await Promise.all(magicedenBids.map(key => redis.del(key)));
    // await Promise.all(blurBids.map(key => redis.del(key)));
    if (task.outbidOptions.counterbid) {
      unsubscribeFromCollection(task);
    }
  } catch (error) {
    console.log(error);
  }
}

async function updateStatus(task: ITask) {
  try {
    const { _id: taskId, running } = task;
    const taskIndex = currentTasks.findIndex(task => task._id === taskId);
    const start = !running;
    if (taskIndex !== -1) {
      currentTasks[taskIndex].running = start;
      if (start) {
        await startTask(task, true)
      } else {
        await stopTask(task, false)
      }
    }
  } catch (error) {
    console.error(RED + `Error updating status for task: ${task._id}` + RESET, error);
  }
}

function unsubscribeFromCollection(task: ITask) {
  const unsubscribeMessage = {
    "topic": `collection:${task.contract.slug}`,
    "event": "phx_leave",
    "payload": {},
    "ref": 0
  };
  ws.send(JSON.stringify(unsubscribeMessage));
  console.log(`Unsubscribed from collection: ${task.contract.slug}`);
}

async function updateMarketplace(task: ITask) {
  try {
    const { _id: taskId, selectedMarketplaces } = task;
    const taskIndex = currentTasks.findIndex(task => task._id === taskId);
    const current = currentTasks[taskIndex].selectedMarketplaces;
    const outgoing = current.filter(marketplace => !selectedMarketplaces.includes(marketplace));
    const jobs = await queue.getJobs(['waiting', 'completed', 'failed', "delayed", "paused"]);
    const selectedJobs = jobs.filter((job) => job.data.slug === task.contract.slug || job.data?.contract?.slug === task?.contract?.slug);
    const incoming = selectedMarketplaces.filter(marketplace => !current.includes(marketplace));

    if (outgoing.map((marketplace) => marketplace.toLowerCase()).includes("opensea")) {
      const openseaJobs = selectedJobs.filter((job) => job.name === OPENSEA_SCHEDULE || job.name === OPENSEA_TRAIT_BID || job.name === OPENSEA_TOKEN_BID)
      await Promise.all(openseaJobs.map(job => job.remove()));

      console.log(RED + `STOPPING ALL WAITING, DELAYED OR PAUSED OPENSEA JOBS FOR ${task.contract.slug}` + RESET);

      const openseaBids = await redis.keys(`opensea:order:${task.contract.slug}:*`);
      const openseaBidData = await Promise.all(openseaBids.map(key => redis.get(key)));
      const cancelData = openseaBidData.map(bid => ({ name: CANCEL_OPENSEA_BID, data: { orderHash: bid, privateKey: task.wallet.privateKey } }));
      await queue.addBulk(cancelData);
      console.log(RED + `CANCELLING ALL ACTIVE OPENSEA BIDS ${task.contract.slug}` + RESET);
    }

    if (outgoing.map((marketplace) => marketplace.toLowerCase()).includes("blur")) {
      const blurJobs = selectedJobs.filter((job) => job.name === BLUR_SCHEDULE || job.name === BLUR_TRAIT_BID)
      await Promise.all(blurJobs.map(job => job.remove()));

      console.log(RED + `STOPPING ALL WAITING, DELAYED OR PAUSED BLUR JOBS ${task.contract.slug}` + RESET);

      const blurBids = await redis.keys(`blur:order:${task.contract.slug}:*`)
      const blurBidData = await Promise.all(blurBids.map(key => redis.get(key)));
      const parsedBlurBid = blurBidData
        .filter(data => data !== null) // Ensure data is not null
        .map((data) => JSON.parse(data))
      const blurCancelData = parsedBlurBid.map((bid) => ({ name: CANCEL_BLUR_BID, data: { payload: bid, privateKey: task.wallet.privateKey } }))
      await queue.addBulk(blurCancelData)
      console.log(RED + `CANCELLING ALL ACTIVE BLUR BIDS ${task.contract.slug}` + RESET);
    }

    if (outgoing.map((marketplace) => marketplace.toLowerCase()).includes("magiceden")) {
      const magicedenJobs = selectedJobs.filter((job) => job.name === MAGICEDEN_SCHEDULE || job.name === MAGICEDEN_TRAIT_BID || job.name === MAGICEDEN_TOKEN_BID)
      await Promise.all(magicedenJobs.map(job => job.remove()));

      console.log(RED + `STOPPING ALL WAITING, DELAYED OR PAUSED MAGICEDEN JOBS FOR ${task.contract.slug}` + RESET);

      const magicedenBids = await redis.keys(`magiceden:order:${task.contract.slug}:*`);
      const magicedenBidData = await Promise.all(magicedenBids.map(key => redis.get(key)));
      const parsedMagicedenBid = magicedenBidData
        .filter(data => data !== null) // Ensure data is not null
        .map((data) => JSON.parse(data))
        .filter((data) => data?.message?.toLowerCase() === "success")
        .map((data) => data.orderId)

      queue.add(CANCEL_MAGICEDEN_BID, { orderIds: parsedMagicedenBid, privateKey: task.wallet.privateKey })
      console.log(RED + `CANCELLING ALL ACTIVE MAGICEDEN BIDS FOR ${task.contract.slug}` + RESET);
    }

    if (incoming.map((marketplace) => marketplace.toLowerCase()).includes("opensea")) {
      queue.add(OPENSEA_SCHEDULE, task)
    }

    if (incoming.map((marketplace) => marketplace.toLowerCase()).includes("magiceden")) {
      queue.add(MAGICEDEN_SCHEDULE, task)
    }

    if (incoming.map((marketplace) => marketplace.toLowerCase()).includes("blur")) {
      queue.add(BLUR_SCHEDULE, task)
    }

    if (taskIndex !== -1) {
      currentTasks[taskIndex].selectedMarketplaces = selectedMarketplaces;
    }

  } catch (error) {
    console.error(RED + `Error updating marketplace for task: ${task._id}` + RESET, error);
  }
}

async function updateMultipleTasksStatus(data: { tasks: ITask[], running: boolean }) {
  try {
    const { tasks, running } = data;
    if (running) {
      const jobs = tasks.map((task) => ({ name: START_TASK, data: task }))
      await queue.addBulk(jobs)
    } else {
      const jobs = tasks.map((task) => ({ name: STOP_TASK, data: task }))
      await queue.addBulk(jobs)
    }
  } catch (error) {
    console.log(error);
  }
}


function connectWebSocket(): void {
  ws = new WebSocket(OPENSEA_WS_URL);
  ws.addEventListener("open", function open() {
    console.log("Connected to OPENSEA Websocket");

    retryCount = 0;
    if (reconnectTimeoutId !== null) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
    if (heartbeatIntervalId !== null) {
      clearInterval(heartbeatIntervalId);
    }
    heartbeatIntervalId = setInterval(() => {
      if (ws) {
        ws.send(
          JSON.stringify({
            topic: "phoenix",
            event: "heartbeat",
            payload: {},
            ref: 0,
          })
        );
      }
    }, 30000);

    if (currentTasks.length > 0) {
      subscribeToCollections(currentTasks as unknown as ITask[])
    }

    ws.on("message", function incoming(data: string) {
      let message;
      try {
        message = JSON.parse(data)
      } catch (error) {
        console.error("Failed to parse message:", error);
        return;
      }
      queue.add(OPENSEA_COUNTERBID, message);
    });
  });

  ws.addEventListener("close", function close() {
    console.log("Disconnected from OpenSea Stream API");
    if (heartbeatIntervalId !== null) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
    attemptReconnect();
  });

  ws.addEventListener("error", function error(err) {
    if (ws) {
      ws.close();
    }
  });
}

function attemptReconnect(): void {
  if (retryCount < MAX_RETRIES) {
    if (reconnectTimeoutId !== null) {
      clearTimeout(reconnectTimeoutId);
    }
    let delay: number = Math.pow(2, retryCount) * 1000;
    console.log(`Attempting to reconnect in ${delay / 1000} seconds...`);
    reconnectTimeoutId = setTimeout(connectWebSocket, delay);
    retryCount++;
  } else {
    console.log("Max retries reached. Giving up on reconnecting.");
  }
}

async function processOpenseaCounterBid(data: any) {
  try {
    const message = data as OpenseaMessagePayload;
    if (!message.payload || !message.payload.payload || !message.payload.payload.protocol_data) return;
    const task = currentTasks.find(task => task.contract.slug === message.payload.payload.collection.slug);
    if (!task || !task.running || !task.outbidOptions.counterbid || !task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea")) return;
    const offerer = message.payload.payload.protocol_data.parameters.offerer;

    const ownWallet = walletsArr
      .map((address) => address.toLowerCase())
      .includes(offerer.toLowerCase());

    if (ownWallet) {
      return;
    }
    console.log(GREEN + `Counterbidding for collection: ${task.contract.slug}` + RESET); // Log message added

    const expiry = task.bidDuration.unit === 'minutes' ? task.bidDuration.value * 60 :
      task.bidDuration.unit === 'hours' ? task.bidDuration.value * 3600 :
        task.bidDuration.unit === 'days' ? task.bidDuration.value * 86400 :
          task.bidDuration.value * 60;
    const { address: WALLET_ADDRESS, privateKey: WALLET_PRIVATE_KEY } = task.wallet;
    const collectionDetails = await getCollectionDetails(task.contract.slug);
    const creatorFees: IFee = collectionDetails.creator_fees.null !== undefined
      ? { null: collectionDetails.creator_fees.null }
      : Object.fromEntries(Object.entries(collectionDetails.creator_fees).map(([key, value]) => [key, Number(value)]));

    const outbidMargin = Number(task.outbidOptions.openseaOutbidMargin) * 1e18;
    const currentOffer = Number(message.payload.payload.base_price);

    console.log({ currentOffer, outbidMargin });
    const offerPrice = BigInt(Math.ceil(currentOffer + outbidMargin));
    console.log({ offerPrice: Number(offerPrice) / 1e18 });

    const protocolAddress = message.payload.payload.protocol_address.toLowerCase();
    const stats = await getCollectionStats(task.contract.slug);
    const floor_price = stats.total.floor_price;

    let maxOfferEth: number;
    if (task.bidPrice.maxType === "percentage") {
      maxOfferEth = Number((floor_price * (task.bidPrice.max || 0) / 100).toFixed(4));
    } else {
      maxOfferEth = task.bidPrice.max || 0;
    }
    const maxOffer = BigInt(Math.ceil(maxOfferEth * 1e18));

    if (maxOffer < offerPrice) {
      console.log(RED + 'OFFER PRICE IS GREATER THAN MAX OFFER' + RESET);
      return
    }

    if (protocolAddress === OPENSEA_PROTOCOL_ADDRESS.toLowerCase()) {
      if (message.payload.event_type === "collection_offer") {
        await bidOnOpensea(WALLET_ADDRESS, WALLET_PRIVATE_KEY, task.contract.slug, offerPrice, creatorFees, collectionDetails.enforceCreatorFee, expiry);
      } else if (message.payload.event_type === "trait_offer") {
        const traitType = message.payload.payload.trait_criteria?.trait_type;
        if (traitType) {
          const traitValid = task.selectedTraits[traitType]?.includes(message.payload.payload.trait_criteria?.trait_name as string);
          if (traitValid) {
            const trait = JSON.stringify({ type: traitType, value: message.payload.payload.trait_criteria?.trait_name });
            await bidOnOpensea(WALLET_ADDRESS, WALLET_PRIVATE_KEY, task.contract.slug, offerPrice, creatorFees, collectionDetails.enforceCreatorFee, expiry, trait);
          }
        }
      }
    }
  } catch (error) {
    console.error(RED + 'Error processing OpenSea counter bid' + RESET, error);
  }
}


async function processOpenseaScheduledBid(task: ITask) {
  try {
    if (!task.running || !task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("opensea")) return

    const expiry = task?.bidDuration?.unit === 'minutes' ? task.bidDuration.value * 60 :
      task?.bidDuration?.unit === 'hours' ? task.bidDuration.value * 3600 :
        task?.bidDuration?.unit === 'days' ? task.bidDuration.value * 86400 :
          900; // Default to seconds if unit is not recognized
    let cachedData = taskCache.get(task._id);
    let WALLET_ADDRESS: string, WALLET_PRIVATE_KEY: string;

    if (cachedData) {
      ({ WALLET_ADDRESS, WALLET_PRIVATE_KEY } = cachedData);
    } else {
      const dbTask = await Task.findOne({ _id: task._id }).exec();
      if (dbTask) {
        WALLET_ADDRESS = dbTask.wallet.address as string;
        WALLET_PRIVATE_KEY = dbTask.wallet.privateKey as string;
        taskCache.set(task._id, { WALLET_ADDRESS, WALLET_PRIVATE_KEY });
      } else {
        throw new Error(`Task with id ${task._id} not found in the database.`);
      }
    }

    const collectionDetails = await getCollectionDetails(task.contract.slug);
    const traitBid = task.selectedTraits && Object.keys(task.selectedTraits).length > 0
    const tokenBid = task.bidType === "token" && task.tokenIds.length > 0
    const stats = await getCollectionStats(task.contract.slug);
    const floor_price = stats.total.floor_price;
    console.log(GREEN + `Current floor price for ${task.contract.slug}: ${floor_price} ETH` + RESET);

    let offerPriceEth: number;
    if (task.bidPrice.minType === "percentage") {
      offerPriceEth = Number((floor_price * task.bidPrice.min / 100).toFixed(4));
      console.log(YELLOW + `Calculated offer price: ${offerPriceEth} ETH (${task.bidPrice.min}% of floor price)` + RESET);
    } else {
      offerPriceEth = task.bidPrice.min;
      console.log(YELLOW + `Using fixed offer price: ${offerPriceEth} ETH` + RESET);
    }
    const offerPrice = BigInt(Math.ceil(offerPriceEth * 1e18)); // convert to wei
    const creatorFees: IFee = collectionDetails.creator_fees.null !== undefined
      ? { null: collectionDetails.creator_fees.null }
      : Object.fromEntries(Object.entries(collectionDetails.creator_fees).map(([key, value]) => [key, Number(value)]));

    if (tokenBid) {
      const jobs = task.tokenIds.map((token) => ({
        name: OPENSEA_TOKEN_BID,
        data: {
          address: WALLET_ADDRESS,
          privateKey: WALLET_PRIVATE_KEY,
          slug: task.contract.slug,
          offerPrice: offerPrice.toString(),
          creatorFees,
          enforceCreatorFee: collectionDetails.enforceCreatorFee,
          asset: { contractAddress: task.contract.contractAddress, tokenId: token },
          expiry
        }
      }))
      await queue.addBulk(jobs)
    } else if (traitBid && collectionDetails.trait_offers_enabled) {
      const traits = transformOpenseaTraits(task.selectedTraits);
      const traitJobs = traits.map((trait) => ({
        name: OPENSEA_TRAIT_BID, data: {
          address: WALLET_ADDRESS,
          privateKey: WALLET_PRIVATE_KEY,
          slug: task.contract.slug,
          offerPrice: offerPrice.toString(),
          creatorFees,
          enforceCreatorFee: collectionDetails.enforceCreatorFee,
          trait: JSON.stringify(trait),
          expiry
        }
      }))

      const jobs = await queue.addBulk(traitJobs)
      console.log(`ADDED ${jobs.length} ${task.contract.slug} OPENSEA TRAIT BID JOBS TO QUEUE`);

    } else {
      await bidOnOpensea(
        WALLET_ADDRESS,
        WALLET_PRIVATE_KEY,
        task.contract.slug,
        offerPrice,
        creatorFees,
        collectionDetails.enforceCreatorFee,
        expiry
      );
    }
  } catch (error) {
    console.error(RED + `Error processing OpenSea scheduled bid for task: ${task._id}` + RESET, error);
  }
}

async function processBlurScheduledBid(task: ITask) {
  try {
    if (!task.running || !task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("blur")) return

    const expiry = task.bidDuration.unit === 'minutes' ? task.bidDuration.value * 60 :
      task.bidDuration.unit === 'hours' ? task.bidDuration.value * 3600 :
        task.bidDuration.unit === 'days' ? task.bidDuration.value * 86400 :
          task.bidDuration.value * 60;
    let cachedData = taskCache.get(task._id);
    let WALLET_ADDRESS: string, WALLET_PRIVATE_KEY: string;

    if (cachedData) {
      ({ WALLET_ADDRESS, WALLET_PRIVATE_KEY } = cachedData);
    } else {
      const dbTask = await Task.findOne({ _id: task._id }).exec();
      if (dbTask) {
        WALLET_ADDRESS = dbTask.wallet.address as string;
        WALLET_PRIVATE_KEY = dbTask.wallet.privateKey as string;
        taskCache.set(task._id, { WALLET_ADDRESS, WALLET_PRIVATE_KEY });
      } else {
        throw new Error(`Task with id ${task._id} not found in the database.`);
      }
    }

    const traitBid = task.selectedTraits && Object.keys(task.selectedTraits).length > 0

    const stats = await getCollectionStats(task.contract.slug);
    const floor_price = stats.total.floor_price;
    console.log(GREEN + `Current floor price for ${task.contract.slug}: ${floor_price} ETH` + RESET);

    let offerPriceEth: number;
    if (task.bidPrice.minType === "percentage") {
      offerPriceEth = Number((floor_price * task.bidPrice.min / 100).toFixed(4));
      console.log(YELLOW + `Calculated offer price: ${offerPriceEth} ETH (${task.bidPrice.min}% of floor price)` + RESET);
    } else {
      offerPriceEth = task.bidPrice.min;
      console.log(YELLOW + `Using fixed offer price: ${offerPriceEth} ETH` + RESET);
    }
    const offerPrice = BigInt(Math.ceil(offerPriceEth * 1e18)); // convert to wei
    const contractAddress = task.contract.contractAddress

    if (traitBid) {
      const traits = transformBlurTraits(task.selectedTraits)
      const traitJobs = traits.map((trait) => ({
        name: BLUR_TRAIT_BID, data: {
          address: WALLET_ADDRESS,
          privateKey: WALLET_PRIVATE_KEY,
          contractAddress,
          offerPrice: offerPrice.toString(),
          slug: task.contract.slug,
          trait: JSON.stringify(trait),
          expiry
        }
      }))

      const jobs = await queue.addBulk(traitJobs)
      console.log(`ADDED ${jobs.length} ${task.contract.slug} BLUR TRAIT BID JOBS TO QUEUE`);
    } else {
      await bidOnBlur(WALLET_ADDRESS, WALLET_PRIVATE_KEY, contractAddress, offerPrice, task.contract.slug, expiry);
      console.log(GREEN + `Successfully placed bid on Blur for ${task.contract.slug}` + RESET);
    }
  } catch (error) {
    console.error(RED + `Error processing Blur scheduled bid for task: ${task._id}` + RESET, error);
  }
}

async function processOpenseaTraitBid(data: {
  address: string;
  privateKey: string;
  slug: string;
  offerPrice: string;
  creatorFees: IFee;
  enforceCreatorFee: boolean;
  trait: string;
  expiry: number;
}) {
  try {
    const { address, privateKey, slug, offerPrice, creatorFees, enforceCreatorFee, trait, expiry } = data
    const colletionOffer = BigInt(offerPrice)
    await bidOnOpensea(
      address,
      privateKey,
      slug,
      colletionOffer,
      creatorFees,
      enforceCreatorFee,
      expiry,
      trait
    );
  } catch (error) {
    console.error(RED + `Error processing OpenSea trait bid for task: ${data.slug}` + RESET, error);
  }
}

async function processOpenseaTokenBid(data: {
  address: string;
  privateKey: string;
  slug: string;
  offerPrice: string;
  creatorFees: IFee;
  enforceCreatorFee: boolean;
  asset: { contractAddress: string, tokenId: number },
  expiry: number;
}) {
  try {
    const { address, privateKey, slug, offerPrice, creatorFees, enforceCreatorFee, asset, expiry } = data
    const colletionOffer = BigInt(offerPrice)
    await bidOnOpensea(address,
      privateKey,
      slug,
      colletionOffer,
      creatorFees,
      enforceCreatorFee,
      expiry,
      undefined,
      asset
    )

  } catch (error) {
    console.log(error);
  }
}

async function processBlurTraitBid(data: {
  address: string;
  privateKey: string;
  contractAddress: string;
  offerPrice: string;
  slug: string;
  trait: string;
  expiry: number;
}) {

  const { address, privateKey, contractAddress, offerPrice, slug, trait, expiry } = data
  const collectionOffer = BigInt(offerPrice)
  try {
    await bidOnBlur(address, privateKey, contractAddress, collectionOffer, slug, expiry, trait)
  } catch (error) {
    console.error(RED + `Error processing Blur trait bid for task: ${data.slug}` + RESET, error);
  }
}

async function processMagicedenScheduledBid(task: ITask) {
  try {
    if (!task.running || !task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("magiceden")) return
    let cachedData = taskCache.get(task._id);
    let WALLET_ADDRESS: string, WALLET_PRIVATE_KEY: string;

    if (cachedData) {
      ({ WALLET_ADDRESS, WALLET_PRIVATE_KEY } = cachedData);
    } else {
      const dbTask = await Task.findOne({ _id: task._id }).exec();
      if (dbTask) {
        WALLET_ADDRESS = dbTask.wallet.address as string;
        WALLET_PRIVATE_KEY = dbTask.wallet.privateKey as string;
        taskCache.set(task._id, { WALLET_ADDRESS, WALLET_PRIVATE_KEY });
      } else {
        throw new Error(`Task with id ${task._id} not found in the database.`);
      }
    }

    const traitBid = task.selectedTraits && Object.keys(task.selectedTraits).length > 0
    const tokenBid = task.bidType === "token" && task.tokenIds.length > 0
    const contractAddress = task.contract.contractAddress

    const expiry = task.bidDuration.unit === 'minutes' ? task.bidDuration.value * 60 :
      task.bidDuration.unit === 'hours' ? task.bidDuration.value * 3600 :
        task.bidDuration.unit === 'days' ? task.bidDuration.value * 86400 :
          task.bidDuration.value * 60;

    const duration = expiry / 60 || 15; // minutes
    const currentTime = new Date().getTime();
    const expiration = Math.floor((currentTime + (duration * 60 * 1000)) / 1000);
    const stats = await getCollectionStats(task.contract.slug);
    const floor_price = stats.total.floor_price;

    let offerPriceEth: number;
    if (task.bidPrice.minType === "percentage") {
      offerPriceEth = Number((floor_price * task.bidPrice.min / 100).toFixed(4));
      console.log(YELLOW + `Calculated offer price: ${offerPriceEth} ETH (${task.bidPrice.min}% of floor price)` + RESET);
    } else {
      offerPriceEth = task.bidPrice.min;
      console.log(YELLOW + `Using fixed offer price: ${offerPriceEth} ETH` + RESET);
    }
    const offerPrice = BigInt(Math.ceil(offerPriceEth * 1e18)).toString(); // convert to wei

    if (tokenBid) {
      const jobs = task.tokenIds.map((token) => ({
        name: MAGICEDEN_TOKEN_BID, data: {
          address: WALLET_ADDRESS,
          contractAddress,
          quantity: 1,
          offerPrice,
          expiration,
          privateKey: WALLET_PRIVATE_KEY,
          slug: task.contract.slug,
          tokenId: token
        }
      }))
      queue.addBulk(jobs)
    }
    else if (traitBid) {
      const traits = Object.entries(task.selectedTraits).flatMap(([key, values]) =>
        values.map(value => ({ attributeKey: key, attributeValue: value }))
      );
      const traitJobs = traits.map((trait) => ({
        name: MAGICEDEN_TRAIT_BID, data: {
          address: WALLET_ADDRESS,
          contractAddress,
          quantity: 1,
          offerPrice,
          expiration,
          privateKey: WALLET_PRIVATE_KEY,
          slug: task.contract.slug,
          trait
        }
      }))
      const jobs = await queue.addBulk(traitJobs)
      console.log(`ADDED ${jobs.length} ${task.contract.slug} MAGICEDEN TRAIT BID JOBS TO QUEUE`);
    } else {
      await bidOnMagiceden(WALLET_ADDRESS, contractAddress, 1, offerPrice.toString(), expiration.toString(), WALLET_PRIVATE_KEY, task.contract.slug);
    }
  } catch (error) {
    console.error(RED + `Error processing MagicEden scheduled bid for task: ${task._id}` + RESET, error);
  }
}

async function processMagicedeTokenBid(data: {
  address: string;
  contractAddress: string;
  quantity: number;
  offerPrice: string;
  expiration: string;
  privateKey: string,
  slug: string;
  tokenId: string | number
}) {
  try {
    const
      { contractAddress,
        address, quantity, offerPrice, expiration, privateKey, slug, tokenId } = data
    bidOnMagiceden(address, contractAddress, quantity, offerPrice, expiration.toString(), privateKey, slug, undefined, tokenId)
  } catch (error) {
    console.error(RED + `Error processing MagicEden token bid for task: ${data.slug}` + RESET, error);
  }
}

async function processMagicedenTraitBid(data: {
  address: string;
  contractAddress: string;
  quantity: number;
  offerPrice: string;
  expiration: string;
  privateKey: string,
  slug: string;
  trait: {
    attributeKey: string;
    attributeValue: string;
  }
}) {
  try {
    const
      { contractAddress,
        address, quantity, offerPrice, expiration, privateKey, slug, trait } = data
    bidOnMagiceden(address, contractAddress, quantity, offerPrice, expiration.toString(), privateKey, slug, trait)
  } catch (error) {
    console.error(RED + `Error processing MagicEden trait bid for task: ${data.slug}` + RESET, error);
    // Handle the error without throwing
  }
}

async function bulkCancelOpenseaBid(data: { orderHash: string, privateKey: string }) {
  try {

    const { orderHash, privateKey } = data
    await cancelOrder(orderHash, OPENSEA_PROTOCOL_ADDRESS, privateKey)
  } catch (error) {
    console.log(error);
  }
}

async function bulkCancelMagicedenBid(data: { orderIds: string[], privateKey: string }) {
  try {
    const { orderIds, privateKey } = data
    if (orderIds.length > 0) {
      await canelMagicEdenBid(orderIds, privateKey)
    }
  } catch (error) {
    console.log(error);
  }
}

async function blukCancelBlurBid(data: BlurCancelPayload) {
  try {
    await cancelBlurBid(data)
  } catch (error) {
    console.log(error);
  }
}

app.get("/", (req, res) => {
  res.json({ message: "Welcome to the NFTTools bidding bot server! Let's make magic happen! 🚀🚀🚀" });
});

function transformBlurTraits(selectedTraits: Record<string, string[]>): { [key: string]: string }[] {
  const result: { [key: string]: string }[] = [];
  for (const [traitType, values] of Object.entries(selectedTraits)) {
    for (const value of values) {
      if (value.includes(',')) {
        const subValues = value.split(',');
        for (const subValue of subValues) {
          result.push({ [traitType]: subValue.trim() });
        }
      } else {
        result.push({ [traitType]: value.trim() });
      }
    }
  }
  return result;
}

async function waitForUnlock(itemId: string, jobType: string) {
  if (waitingQueueCount >= MAX_WAITING_QUEUE) {
    console.log(
      `Max waiting queue size reached. Ignoring ${jobType} for item ${itemId}.`
    );
    return;
  }

  waitingQueueCount++;
  try {
    while (itemId && itemLocks.get(itemId)) {
      console.log(`Waiting for item ${itemId} to be unlocked for ${jobType}.`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    waitingQueueCount--;
  }
}

function transformOpenseaTraits(selectedTraits: Record<string, string[]>): { type: string; value: string }[] {
  const result: { type: string; value: string }[] = [];

  for (const [traitType, values] of Object.entries(selectedTraits)) {
    for (const value of values) {
      if (value.includes(',')) {
        const subValues = value.split(',');
        for (const subValue of subValues) {
          result.push({ type: traitType, value: subValue.trim() });
        }
      } else {
        result.push({ type: traitType, value: value.trim() });
      }
    }
  }

  return result;
}

function subscribeToCollections(tasks: ITask[]) {
  try {
    tasks.forEach((task) => {
      const subscriptionMessage = {
        "topic": `collection:${task.contract.slug}`,
        "event": "phx_join",
        "payload": {},
        "ref": 0
      };
      if (task.running && task.outbidOptions.counterbid) {
        ws.send(JSON.stringify(subscriptionMessage));
        console.log('----------------------------------------------------------------------');
        console.log(`SUBSCRIBED TO COLLECTION: ${task.contract.slug}`);
        console.log('----------------------------------------------------------------------');
      }
    });
  } catch (error) {
    console.error(RED + 'Error subscribing to collections' + RESET, error);
  }
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
export interface ITask {
  _id: string;
  user: string
  contract: {
    slug: string;
    contractAddress: string;
  };
  wallet: {
    address: string;
    privateKey: string;
  };
  selectedMarketplaces: string[];
  running: boolean;
  tags: { name: string; color: string }[];
  selectedTraits: Record<string, string[]>;
  traits: {
    categories: Record<string, string>;
    counts: Record<string, Record<string, number>>;
  };
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  };
  bidPrice: {
    min: number;
    max: number | null;
    minType: "percentage" | "eth";
    maxType: "percentage" | "eth";
  };

  openseaBidPrice: {
    min: number;
    max: number | null;
    minType: "percentage" | "eth";
    maxType: "percentage" | "eth";
  };

  blurBidPrice: {
    min: number;
    max: number | null;
    minType: "percentage" | "eth";
    maxType: "percentage" | "eth";
  };

  magicEdenBidPrice: {
    min: number;
    max: number | null;
    minType: "percentage" | "eth";
    maxType: "percentage" | "eth";
  };

  stopOptions: {
    minFloorPrice: number | null;
    maxFloorPrice: number | null;
    minTraitPrice: number | null;
    maxTraitPrice: number | null;
    maxPurchase: number | null;
    pauseAllBids: boolean;
    stopAllBids: boolean;
    cancelAllBids: boolean;
    triggerStopOptions: boolean;
  };
  bidDuration: { value: number; unit: string };
  tokenIds: number[];
  bidType: string;
  loopInterval: { value: number; unit: string };
}
interface OpenseaMessagePayload {

  event: string;
  payload: {
    event_type: string;
    payload: {
      asset_contract_criteria: {
        address: string;
      };
      base_price: string;
      chain: string;
      collection: {
        slug: string;
      };
      collection_criteria: {
        slug: string;
      };
      created_date: string;
      event_timestamp: string;
      expiration_date: string;
      item: Record<string, unknown>;
      maker: {
        address: string;
      };
      order_hash: string;
      payment_token: {
        address: string;
        decimals: number;
        eth_price: string;
        name: string;
        symbol: string;
        usd_price: string;
      };
      protocol_address: string;
      protocol_data: {
        parameters: {
          conduitKey: string;
          consideration: Array<{
            endAmount: string;
            identifierOrCriteria: string;
            itemType: number;
            recipient: string;
            startAmount: string;
            token: string;
          }>;
          counter: number;
          endTime: string;
          offer: Array<{
            endAmount: string;
            identifierOrCriteria: string;
            itemType: number;
            startAmount: string;
            token: string;
          }>;
          offerer: string;
          orderType: number;
          salt: string;
          startTime: string;
          totalOriginalConsiderationItems: number;
          zone: string;
          zoneHash: string;
        };
        signature: string | null;
      };
      quantity: number;
      taker: string | null;
      trait_criteria?: { trait_name: string, trait_type: string }

    };
    sent_at: string;
  };
  ref: string | null;
  topic: string;

};

// 5420455035