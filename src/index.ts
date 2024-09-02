import express from "express";
import { config } from "dotenv";
import bodyParser from "body-parser";
import Bottleneck from "bottleneck";
import cors from "cors";
import { Server as WebSocketServer } from 'ws';
import http from 'http';
import PQueue from "p-queue";
import { initialize } from "./init";
import { bidOnOpensea, IFee } from "./marketplace/opensea";
import { bidOnBlur } from "./marketplace/blur/bid";
import { bidOnMagiceden } from "./marketplace/magiceden";
import { getCollectionDetails } from "./functions";

config();

const app = express();
const port = process.env.PORT || 3003;

app.use(bodyParser.json());
app.use(cors());

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY as string;
const WALLET_ADDRESS = "0x06c0971e22bd902Fb4DC0cEcb214F1653F1A7B94"

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const RATE_LIMIT = 8

const queue = new PQueue({
  concurrency: 1.5 * RATE_LIMIT
});

// Arrays for tracking tasks
const currentTasks: ITask[] = [];
const incomingTasks: ITask[] = [];
const updatedTasks: ITask[] = [];

config()

export const limiter = new Bottleneck({
  minTime: 1 / RATE_LIMIT,
});



// WebSocket connection handler
wss.on('connection', (ws: WebSocket) => {
  console.log('New WebSocket connection');

  ws.onmessage = async (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data);

      if (message.endpoint === 'tasks') {
        const tasks: ITask[] = message.data;
        await processTasks(tasks);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket connection closed');
  };
});

// process tasks in a queue
async function processTasks(tasks: ITask[]) {
  try {
    console.log('Received tasks:', tasks.map(task => ({ ...task, walletPrivateKey: 'xxxx-xxxx-xxxx-xxxx' })));

    // Clear incomingTasks before processing new tasks
    incomingTasks.length = 0;

    const tasksToProcess: ITask[] = [];

    tasks.forEach(task => {
      const existingTaskIndex = currentTasks.findIndex(t => t.id === task.id);

      if (existingTaskIndex === -1) {
        // New task
        incomingTasks.push(task);
        currentTasks.push(task);
        tasksToProcess.push(task);
      } else {
        const existingTask = currentTasks[existingTaskIndex];
        if (JSON.stringify(existingTask) !== JSON.stringify(task)) {
          // Updated task
          updatedTasks.push(task);
          currentTasks[existingTaskIndex] = task;
          tasksToProcess.push(task);
        }
        incomingTasks.push(task); // Add to incomingTasks if it exists
      }
    });

    // Remove tasks from currentTasks that are not in incomingTasks
    for (let i = currentTasks.length - 1; i >= 0; i--) {
      if (!incomingTasks.some(task => task.id === currentTasks[i].id)) {
        currentTasks.splice(i, 1);
      }
    }

    console.log('Updated tasks:', updatedTasks.map(task => ({ ...task, walletPrivateKey: 'xxxx-xxxx-xxxx-xxxx' })));

    if (tasksToProcess.length > 0) {
      await processUpdatedTasks(tasksToProcess);
    } else {
      console.log('No new or updated tasks to process');
    }

  } catch (error) {
    console.error('Error processing tasks:', error);
  }
}

// process updated tasks
async function processUpdatedTasks(tasksToProcess: ITask[]) {
  try {
    // Process tasks using queue.addAll
    await queue.addAll(
      tasksToProcess.map((task) => async () => {
        await processTask(task);
      })
    );

    // Clear updatedTasks after processing
    updatedTasks.length = 0;

    console.log('Finished processing tasks');
  } catch (error) {
    console.error('Error processing tasks:', error);
  }
}

async function processTask(task: ITask) {
  // Add your task processing logic here
  const offerPrice = BigInt(0.01 * 1e18)
  const collectionDetails = await getCollectionDetails(task.slug)

  const creatorFees: IFee = collectionDetails.creator_fees.null !== undefined
    ? { null: collectionDetails.creator_fees.null }
    : Object.fromEntries(Object.entries(collectionDetails.creator_fees).map(([key, value]) => [key, Number(value)]));

  const contractAddress = collectionDetails.primary_asset_contracts_address

  for (const marketplace of task.selectedMarketplaces) {
    if (marketplace.toLowerCase() === "opensea") {
      await bidOnOpensea(
        WALLET_ADDRESS,
        WALLET_PRIVATE_KEY,
        task.slug,
        offerPrice,
        creatorFees,
        collectionDetails.enforceCreatorFee
      );
    }
    else if (marketplace.toLowerCase() === "magiceden") {
      const duration = 15 // minutes
      const currentTime = new Date().getTime();
      const expiration = Math.floor((currentTime + (duration * 60 * 1000)) / 1000);

      await bidOnMagiceden(WALLET_ADDRESS, contractAddress, 1, offerPrice.toString(), expiration.toString(), WALLET_PRIVATE_KEY, task.slug)

    } else if (marketplace.toLowerCase() === "blur") {
      await bidOnBlur(WALLET_ADDRESS, WALLET_PRIVATE_KEY, contractAddress, offerPrice, task.slug)
    }
  }
}

app.get("/", (req, res) => {
  res.json({ message: "Welcome to the NFTTools bidding bot server! Let's make magic happen hello world! 🚀🚀🚀" });
});


async function startServer() {
  await initialize();
  server.listen(port, () => {
    console.log(`Magic happening on http://localhost:${port}`);
    console.log(`WebSocket server is running on ws://localhost:${port}`);
  });
}

// Call the async start function
startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

interface ITask {
  slug: string;
  selectedWallet: string;
  walletPrivateKey: string;
  minFloorPricePercentage: number;
  maxFloorPricePercentage: number;
  selectedMarketplaces: string[];
  running: boolean;
  id: string;
}
