import express from "express";
import { config } from "dotenv";
import bodyParser from "body-parser";
import cors from "cors";
import WebSocket, { Server as WebSocketServer } from 'ws';
import http from 'http';
import PQueue from "p-queue";
import { initialize } from "./init";
import { bidOnOpensea, IFee } from "./marketplace/opensea";
import { bidOnBlur } from "./marketplace/blur/bid";
import { bidOnMagiceden } from "./marketplace/magiceden";
import { getCollectionDetails, getCollectionStats } from "./functions";
import mongoose from 'mongoose';
import Task from "./models/task.model";

const GREEN = '\x1b[32m';
export const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
export const RESET = '\x1b[0m';
const RED = '\x1b[31m';
export const MAGENTA = '\x1b[35m';


config();

const app = express();
const port = process.env.PORT || 3003;

app.use(bodyParser.json());
app.use(cors());


const server = http.createServer(app);
const wss = new WebSocketServer({ server });

async function startServer() {
  try {
    await mongoose.connect(process.env.MONGODB_URI as string);
    console.log('Connected to MongoDB');

    await initialize(); // This will update RATE_LIMIT with the correct value
    server.listen(port, () => {
      console.log(`Magic happening on http://localhost:${port}`);
      console.log(`WebSocket server is running on ws://localhost:${port}`);
    });
  } catch (error) {
    console.error(RED + 'Failed to connect to MongoDB:' + RESET, error);
    process.exit(1);
  }
}

// Call the async start function
startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

const currentTasks: ITask[] = [];

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log(GREEN + 'New WebSocket connection' + RESET);

  ws.onmessage = async (event: WebSocket.MessageEvent) => {
    try {
      const message = JSON.parse(event.data as string);
      console.log(BLUE + 'Received WebSocket message:' + RESET, message);

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

const taskQueue = new PQueue({ concurrency: 20 }); // Single queue for tasks and bids

async function run() {
  try {
    await Promise.all(
      currentTasks.map(task =>
        taskQueue.add(async () => { // Use the single queue here
          if (task.running) {
            await processTask(task);
          }
        })
      )
    );
  } catch (error) {
    console.error(RED + 'Error in run function:' + RESET, error);
  }
}

run()

async function processNewTask(task: ITask) {
  currentTasks.push(task);
  console.log(GREEN + `Added new task: ${task.contract.slug}` + RESET);
}

async function processUpdatedTask(task: ITask) {
  const existingTaskIndex = currentTasks.findIndex(t => t._id === task._id);

  if (existingTaskIndex !== -1) {
    // Remove old version and add new version
    currentTasks.splice(existingTaskIndex, 1, task);
    console.log(YELLOW + `Updated existing task: ${task.contract.slug}` + RESET);
  } else {
    console.log(RED + `Attempted to update non-existent task: ${task.contract.slug}` + RESET);
  }

  currentTasks.push(task)
}

const taskCache = new Map<string, { WALLET_ADDRESS: string, WALLET_PRIVATE_KEY: string }>();

async function processTask(task: ITask) {
  try {
    let cachedData = taskCache.get(task._id);
    let WALLET_ADDRESS, WALLET_PRIVATE_KEY;

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

    console.log(BLUE + `Processing task for collection: ${task.contract.slug}` + RESET);
    const collectionDetails = await getCollectionDetails(task.contract.slug);
    const traitBid = task.selectedTraits && Object.keys(task.selectedTraits).length > 0

    console.log(GREEN + `Retrieved collection details for ${task.contract.slug}` + RESET);

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

    const contractAddress = collectionDetails.primary_asset_contracts_address;

    const bidTasks = task.selectedMarketplaces.map(marketplace => async () => {
      console.log(BLUE + `Attempting to place bid on ${marketplace}` + RESET);
      try {
        if (marketplace.toLowerCase() === "opensea") {

          if (traitBid && collectionDetails.trait_offers_enabled) {
            const traits = transformOpenseaTraits(task.selectedTraits);
            traits.forEach(trait => {
              taskQueue.add(() => bidOnOpensea(
                WALLET_ADDRESS,
                WALLET_PRIVATE_KEY,
                task.contract.slug,
                offerPrice,
                creatorFees,
                collectionDetails.enforceCreatorFee,
                JSON.stringify(trait)
              ));
            });
          } else {
            await bidOnOpensea(
              WALLET_ADDRESS,
              WALLET_PRIVATE_KEY,
              task.contract.slug,
              offerPrice,
              creatorFees,
              collectionDetails.enforceCreatorFee
            );
          }

        } else if (marketplace.toLowerCase() === "magiceden") {
          const duration = 15; // minutes
          const currentTime = new Date().getTime();
          const expiration = Math.floor((currentTime + (duration * 60 * 1000)) / 1000);


          if (traitBid) {
            const traits = Object.entries(task.selectedTraits).flatMap(([key, values]) =>
              values.map(value => ({ attributeKey: key, attributeValue: value }))
            );

            traits.forEach(trait => {
              taskQueue.add(() => bidOnMagiceden(WALLET_ADDRESS, contractAddress, 1, offerPrice.toString(), expiration.toString(), WALLET_PRIVATE_KEY, task.contract.slug, trait));
            });
          } else {
            await bidOnMagiceden(WALLET_ADDRESS, contractAddress, 1, offerPrice.toString(), expiration.toString(), WALLET_PRIVATE_KEY, task.contract.slug);
          }

          console.log(GREEN + `Successfully placed bid on MagicEden for ${task.contract.slug}` + RESET);
        } else if (marketplace.toLowerCase() === "blur") {
          if (traitBid) {
            const traits = transformBlurTraits(task.selectedTraits)
            traits.forEach(trait => {
              taskQueue.add(() => bidOnBlur(WALLET_ADDRESS, WALLET_PRIVATE_KEY, contractAddress, offerPrice, task.contract.slug, JSON.stringify(trait)));
            });
          } else {
            await bidOnBlur(WALLET_ADDRESS, WALLET_PRIVATE_KEY, contractAddress, offerPrice, task.contract.slug);
            console.log(GREEN + `Successfully placed bid on Blur for ${task.contract.slug}` + RESET);
          }
        }
      } catch (error) {
        console.error(RED + `Error processing task for ${task.contract.slug} on ${marketplace}:` + RESET, error);
      }
    });

    await Promise.all(bidTasks.map(bidTask => taskQueue.add(bidTask))); // Use the single queue for bid tasks
    console.log(GREEN + `Completed processing task for ${task.contract.slug}` + RESET);
  } catch (error) {
    console.error(RED + `Error processing task for ${task.contract.slug}:` + RESET, error);
  }
}

async function updateStatus(task: ITask) {
  const { _id: taskId, running } = task;
  const taskIndex = currentTasks.findIndex(task => task._id === taskId);

  const start = !running

  if (taskIndex !== -1) {
    currentTasks[taskIndex].running = start;

    if (start) {
      console.log(YELLOW + `Updated task ${task.contract.slug} running status to: ${start}` + RESET);
      await processTask(currentTasks[taskIndex])
    } else {
      console.log(YELLOW + `Stopped processing task ${task.contract.slug}` + RESET);
    }
  } else {
    currentTasks.push(task)
    if (start) {
      await processTask(task)
    }
  }
}

async function updateMultipleTasksStatus(data: { taskIds: string[], running: boolean }) {
  const { taskIds, running } = data;

  taskQueue.addAll(taskIds.map(taskId => async () => {
    const taskIndex = currentTasks.findIndex(task => task._id === taskId);
    if (taskIndex !== -1) {
      currentTasks[taskIndex].running = running;
      if (running) {
        await processTask(currentTasks[taskIndex]);
      }
      console.log(YELLOW + `Updated task ${currentTasks[taskIndex].contract.slug} running status to: ${running}` + RESET);
    } else {
      console.log(RED + `Task ${taskId} not found` + RESET);
    }
  }));

  await taskQueue.onIdle();
}

app.get("/", (req, res) => {
  res.json({ message: "Welcome to the NFTTools bidding bot server! Let's make magic happen hello world! 🚀🚀🚀" });
});

function transformBlurTraits(selectedTraits: Record<string, string[]>): { [key: string]: string }[] {
  const result: { [key: string]: string }[] = [];

  for (const [traitType, values] of Object.entries(selectedTraits)) {
    for (const value of values) {
      if (value.includes(',')) {
        // Split the comma-separated values and add them individually
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


function transformOpenseaTraits(selectedTraits: Record<string, string[]>): { type: string; value: string }[] {
  const result: { type: string; value: string }[] = [];

  for (const [traitType, values] of Object.entries(selectedTraits)) {
    for (const value of values) {
      if (value.includes(',')) {
        // Split the comma-separated values and add them individually
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


export interface ITask {
  _id: string;
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
}