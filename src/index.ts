import express from "express";
import { config } from "dotenv";
import bodyParser from "body-parser";
import cors from "cors";
import WebSocket, { Server as WebSocketServer } from 'ws';
import http from 'http';
import { initialize } from "./init";
import { bidOnOpensea, cancelOrder, fetchOpenseaListings, fetchOpenseaOffers, IFee } from "./marketplace/opensea";
import { bidOnBlur, cancelBlurBid, fetchBlurBid, fetchBlurCollectionStats } from "./marketplace/blur/bid";
import { bidOnMagiceden, cancelMagicEdenBid, fetchMagicEdenCollectionStats, fetchMagicEdenOffer, fetchMagicEdenTokens } from "./marketplace/magiceden";
import { getCollectionDetails, getCollectionStats } from "./functions";
import mongoose from 'mongoose';
import Task from "./models/task.model";
import { Queue, Worker, QueueEvents, Job, QueueOptions } from "bullmq";
import Wallet from "./models/wallet.model";
import redisClient from "./utils/redis";
import { WETH_CONTRACT_ADDRESS, WETH_MIN_ABI } from "./constants";
import { constants, Contract, ethers, Wallet as Web3Wallet } from "ethers";
import { DistributedLockManager } from "./utils/lock";

const SEAPORT = '0x1e0049783f008a0085193e00003d00cd54003c71';
const redis = redisClient.getClient()
const CANCEL_PRIORITY = {
  OPENSEA: 1,
  MAGICEDEN: 1,
  BLUR: 1
};

const TOKEN_BID_PRIORITY = {
  OPENSEA: 4,
  MAGICEDEN: 4,
  BLUR: 4
};

const TRAIT_BID_PRIORITY = {
  OPENSEA: 4,
  MAGICEDEN: 4,
  BLUR: 4
};

const COLLECTION_BID_PRIORITY = {
  OPENSEA: 4,
  MAGICEDEN: 4,
  BLUR: 4
};
config()

const lockManager = new DistributedLockManager(redis, {
  lockPrefix: 'marketplace:',
  defaultTTLSeconds: 60
});

export const MAGENTA = '\x1b[35m';
export const BLUE = '\x1b[34m';
export const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GOLD = '\x1b[33m';

const OPENSEA = "OPENSEA";
const MAGICEDEN = "MAGICEDEN";
const BLUR = "BLUR";

export const currentTasks: ITask[] = [];

const QUEUE_NAME = 'BIDDING_BOT';

export const OPENSEA_SCHEDULE = "OPENSEA_SCHEDULE"
export const OPENSEA_TRAIT_BID = "OPENSEA_TRAIT_BID"
export const BLUR_TRAIT_BID = "BLUR_TRAIT_BID"
export const BLUR_SCHEDULE = "BLUR_SCHEDULE"
const MAGICEDEN_SCHEDULE = "MAGICEDEN_SCHEDULE"
const MAGICEDEN_TOKEN_BID = "MAGICEDEN_TOKEN_BID"
export const OPENSEA_TOKEN_BID = "OPENSEA_TOKEN_BID"
const MAGICEDEN_TRAIT_BID = "MAGICEDEN_TRAIT_BID"
const CANCEL_OPENSEA_BID = "CANCEL_OPENSEA_BID"
const CANCEL_MAGICEDEN_BID = "CANCEL_MAGICEDEN_BID"
const CANCEL_BLUR_BID = "CANCEL_BLUR_BID"
const MAGICEDEN_MARKETPLACE = "0x9A1D00bEd7CD04BCDA516d721A596eb22Aac6834"

const MAX_RETRIES: number = 5;
const RATE_LIMIT = 64
const MARKETPLACE_WS_URL = "wss://wss-marketplace.nfttools.website";
const ALCHEMY_API_KEY = "0rk2kbu11E5PDyaUqX1JjrNKwG7s4ty5"

const OPENSEA_PROTOCOL_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395"
const QUEUE_OPTIONS: QueueOptions = {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    removeOnComplete: true,
    removeOnFail: true,
  }
};

export const queue = new Queue(QUEUE_NAME, QUEUE_OPTIONS);

const queueEvents = new QueueEvents(QUEUE_NAME, {
  connection: redis
});

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

const walletsArr: string[] = []

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    try {
      const result = await processJob(job);
      cleanupMemory();
      return result;
    } catch (error) {
      console.error(RED + `Error processing job ${job.id}:`, error, RESET);
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: RATE_LIMIT,
    maxStalledCount: 3,
    lockDuration: 30000,
    limiter: {
      max: RATE_LIMIT,
      duration: 1000
    }
  }
);

worker.on('error', error => {
  console.error(RED + 'Worker error:', error.message, RESET);
});

worker.on('failed', (job, error) => {
  if (job) {
    console.error(RED + `Job ${job.id} failed:`, error.message, RESET);
  }
});

worker.on('stalled', jobId => {
  console.warn(YELLOW + `Job ${jobId} stalled - will be retried` + RESET);
});

// Add these constants at the top
const MAX_TOTAL_JOBS = 1000; // Maximum total jobs allowed in queue
const MAX_BATCH_TOTAL = 256; // Maximum jobs to process in one bulk operation

// Add near the top with other imports
import { clearTimeout } from 'timers';

// Add these functions
function cleanupMemory() {
  if (global.gc) {
    global.gc();
  }
}

async function checkQueueHealth() {
  const activeCount = await queue.getActiveCount();
  const waitingCount = await queue.getWaitingCount();

  if (activeCount + waitingCount > MAX_BATCH_TOTAL) {
    console.log('Queue size exceeds limit, pausing new jobs...');
    await queue.pause();
    // Wait for jobs to process down
    while ((await queue.getActiveCount()) > RATE_LIMIT) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await queue.resume();
  }
}

// Add this constant near the top with other constants
const MIN_ACTIVE_JOBS = RATE_LIMIT;

// Add a new function to replenish jobs
async function replenishJobs() {
  try {
    const activeCount = await queue.getActiveCount();
    const waitingCount = await queue.getWaitingCount();
    const totalPendingJobs = activeCount + waitingCount;

    if (totalPendingJobs < MIN_ACTIVE_JOBS) {
      console.log(YELLOW + `Job count (${totalPendingJobs}) below minimum threshold (${MIN_ACTIVE_JOBS}). Replenishing...`.toUpperCase() + RESET);

      // Get all running tasks
      const runningTasks = currentTasks.filter(task => task.running);

      // Create new jobs from running tasks
      const jobs = runningTasks.flatMap(task => [
        ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea") ?
          [{ name: OPENSEA_SCHEDULE, data: task, opts: { priority: COLLECTION_BID_PRIORITY.OPENSEA } }] : []),
        ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur") ?
          [{ name: BLUR_SCHEDULE, data: task, opts: { priority: COLLECTION_BID_PRIORITY.BLUR } }] : []),
        ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden") ?
          [{ name: MAGICEDEN_SCHEDULE, data: task, opts: { priority: COLLECTION_BID_PRIORITY.MAGICEDEN } }] : [])
      ]);

      if (jobs.length > 0) {
        const batches = [];
        for (let i = 0; i < jobs.length; i += RATE_LIMIT) {
          batches.push(jobs.slice(i, i + RATE_LIMIT));
        }
        await processBulkJobs(batches);
        console.log(GREEN + `Replenished queue with ${jobs.length} new jobs`.toUpperCase() + RESET);
      }
    }
  } catch (error) {
    console.error(RED + 'Error replenishing jobs:' + RESET, error);
  }
}

// Add this helper function near the top with other utility functions


// Modify the monitorHealth function
async function monitorHealth() {
  try {
    const used = process.memoryUsage();
    const memoryStats = {
      rss: `${Math.round(used.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(used.external / 1024 / 1024)}MB`,
    };

    const queueStats = {
      waiting: await queue.getWaitingCount(),
      active: await queue.getActiveCount(),
      failed: await queue.getFailedCount(),
      delayed: await queue.getDelayedCount(),
      paused: (await queue.getJobs(["paused"])).length
    };

    const totalPendingJobs = queueStats.active + queueStats.waiting;

    // Check if we need to replenish jobs
    if (totalPendingJobs < MIN_ACTIVE_JOBS) {
      await replenishJobs();
    }

    // Modified queue management logic
    if (queueStats.active > RATE_LIMIT * 2) {
      console.log(YELLOW + 'Pausing queue temporarily due to high load...'.toUpperCase() + RESET);
      await queue.pause();
      // Resume after a short delay
      setTimeout(async () => {
        await queue.resume();
        console.log(GREEN + 'Resuming queue after pause...'.toUpperCase() + RESET);
      }, 5000);
    } else {
      await queue.resume();
    }

    const totalJobs = Object.values(queueStats).reduce((a, b) => a + b, 0);

    console.log('\n=== Health Monitor Stats ===');

    console.log(BLUE + '\nMemory Usage:' + RESET);
    Object.entries(memoryStats).forEach(([key, value]) => {
      console.log(`${key}: ${value}`);
    });

    console.log(BLUE + '\nQueue Status:' + RESET);
    Object.entries(queueStats).forEach(([key, value]) => {
      const color = value > 100 ? RED : value > 50 ? YELLOW : GREEN;
      console.log(`${key}: ${color}${value}${RESET}`);
    });
    console.log(`Total Jobs: ${totalJobs}`);

    const isWorkerActive = worker.isRunning();
    console.log(BLUE + '\nWorker Status:' + RESET, isWorkerActive ? GREEN + 'Running' + RESET : RED + 'Stopped' + RESET);

    // ... rest of the monitoring code ...
  } catch (error) {
    console.error(RED + 'Error monitoring health:' + RESET, error);
  }
}

// Increase the health check frequency
const HEALTH_CHECK_INTERVAL = 3000; // Check every 3 seconds instead of 5
setInterval(monitorHealth, HEALTH_CHECK_INTERVAL);

async function cleanup() {
  console.log(YELLOW + '\n=== Starting Cleanup ===');

  console.log('Stopping health monitor...');
  for (const timeout of require('timers').getActiveHandles()) {
    if (timeout._onTimeout === monitorHealth) {
      clearInterval(timeout);
    }
  }

  console.log('Closing worker...');
  await worker.close();

  console.log('Closing queue...');
  await queue.close();

  console.log(GREEN + '=== Cleanup Complete ===\n' + RESET);
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

async function fetchCurrentTasks() {
  try {
    console.log(BLUE + '\n=== Fetching Current Tasks ===');

    const tasks = await Task.find({}).lean().exec() as unknown as ITask[];
    const wallets = (await Wallet.find({}).lean()).map((wallet: any) => wallet.address);

    walletsArr.push(...wallets);
    const formattedTasks = tasks.map((task) => ({
      ...task,
      _id: task._id.toString(),
      user: task.user.toString()
    }));

    console.log(`Found ${formattedTasks.length} tasks`);
    currentTasks.push(...formattedTasks);

    console.log('Creating initial jobs...');
    const jobs = formattedTasks
      .filter((task) => task.running)
      .flatMap(task =>
        task.running && task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea")
          ? [{ name: OPENSEA_SCHEDULE, data: task, opts: { priority: COLLECTION_BID_PRIORITY.OPENSEA } }]
          : []
      ).concat(
        formattedTasks.flatMap(task =>
          task.running && task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur")
            ? [{ name: BLUR_SCHEDULE, data: task, opts: { priority: COLLECTION_BID_PRIORITY.BLUR } }]
            : []
        )
      ).concat(
        formattedTasks.flatMap(task =>
          task.running && task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden")
            ? [{ name: MAGICEDEN_SCHEDULE, data: task, opts: { priority: COLLECTION_BID_PRIORITY.MAGICEDEN } }]
            : []
        )
      );

    console.log(`Created ${jobs.length} initial jobs`);
    await processBulkJobs(jobs);

    console.log(GREEN + '=== Task Initialization Complete ===\n' + RESET);
  } catch (error) {
    console.error(RED + 'Error fetching current tasks:', error, RESET);
  }
}

const DOWNTIME_THRESHOLD = 30 * 60 * 1000;
const LAST_RUNTIME_KEY = 'server:last_runtime';

async function startServer() {
  try {
    await initialize();
    await mongoose.connect(process.env.MONGODB_URI as string);
    console.log('Connected to MongoDB');

    const lastRuntime = await redis.get(LAST_RUNTIME_KEY);
    const currentTime = Date.now();

    if (lastRuntime) {
      const downtime = currentTime - parseInt(lastRuntime);
      if (downtime > DOWNTIME_THRESHOLD) {
        console.log(YELLOW + `Server was down for ${Math.round(downtime / 60000)} minutes. Clearing queue...` + RESET);
        await queue.drain();
      }
    }

    await redis.set(LAST_RUNTIME_KEY, currentTime.toString());

    setInterval(async () => {
      await redis.set(LAST_RUNTIME_KEY, Date.now().toString());
    }, 60000);

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
        case 'stop-task':
          await stopTask(message.data, false);
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


connectWebSocket()

async function processJob(job: Job) {
  switch (job.name) {
    case OPENSEA_SCHEDULE:
      return await processOpenseaScheduledBid(job.data);
    case OPENSEA_TRAIT_BID:
      return await processOpenseaTraitBid(job.data);
    case OPENSEA_TOKEN_BID:
      return await processOpenseaTokenBid(job.data);
    case BLUR_SCHEDULE:
      return await processBlurScheduledBid(job.data);
    case BLUR_TRAIT_BID:
      return await processBlurTraitBid(job.data);
    case MAGICEDEN_SCHEDULE:
      return await processMagicedenScheduledBid(job.data);
    case MAGICEDEN_TRAIT_BID:
      return await processMagicedenTraitBid(job.data);
    case MAGICEDEN_TOKEN_BID:
      return await processMagicedenTokenBid(job.data);
    case CANCEL_OPENSEA_BID:
      return await bulkCancelOpenseaBid(job.data);
    case CANCEL_MAGICEDEN_BID:
      return await bulkCancelMagicedenBid(job.data);
    case CANCEL_BLUR_BID:
      return await blukCancelBlurBid(job.data);
    default:
      throw new Error(`Unknown job type: ${job.name}`);
  }
}

queueEvents.on('failed', ({ jobId, failedReason }) => {
  console.log(RED + `JOB ${jobId} FAILED: ${failedReason}` + RESET);
});



const DELAY_MS = 1000;
const MAX_CONCURRENT_BATCHES = 4

async function processBulkJobs(jobs: any[]) {
  if (!jobs || jobs.length === 0) {
    return;
  }

  const batches = [];
  for (let i = 0; i < jobs.length; i += RATE_LIMIT) {
    batches.push(jobs.slice(i, i + RATE_LIMIT));
  }

  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
    const currentBatches = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
    await Promise.all(currentBatches.map(async (batch, index) => {
      try {
        await queue.addBulk(
          batch.map((job) => ({
            name: job.name,
            data: job.data,
            opts: {
              ...job.opts,
              removeOnComplete: true,
              removeOnFail: true,
              attempts: 3,
              backoff: {
                type: "exponential",
                delay: 2000,
              },
              timeout: 45000,
            },
          }))
        );

        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      } catch (error) {
        console.error(`Error adding batch ${i + index + 1}:`, error);
      }
    }));
  }
}


async function processNewTask(task: ITask) {
  try {
    console.log(BLUE + `\n=== Processing New Task ===` + RESET);
    console.log(`Collection: ${task.contract.slug}`);
    console.log(`Task ID: ${task._id}`);

    currentTasks.push(task);
    console.log(GREEN + `Added task to currentTasks (Total: ${currentTasks.length})` + RESET);

    const jobs = [
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea") ? [{ name: OPENSEA_SCHEDULE, data: task, opts: { priority: COLLECTION_BID_PRIORITY.OPENSEA } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur") ? [{ name: BLUR_SCHEDULE, data: task, opts: { priority: COLLECTION_BID_PRIORITY.BLUR } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden") ? [{ name: MAGICEDEN_SCHEDULE, data: task, opts: { priority: COLLECTION_BID_PRIORITY.MAGICEDEN } }] : []),
    ];

    if (jobs.length > 0) {
      await processBulkJobs(jobs);
      console.log(`Successfully added ${jobs.length} jobs to the queue.`);
    }
    subscribeToCollections([task]);
    console.log(GREEN + `=== New Task Processing Complete ===\n` + RESET);
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
      if (task.running) {
        await stopTask(task, false)
        await new Promise(resolve => setTimeout(resolve, 1000));
        await startTask(task, true)
      }
      if (task.running && task.outbidOptions.counterbid) {
        subscribeToCollections([task]);
      }
    } else {
      console.log(RED + `Attempted to update non-existent task: ${task.contract.slug}` + RESET);
    }
  } catch (error) {
    console.error(RED + `Error processing updated task: ${task.contract.slug}` + RESET, error);
  }
}

async function startTask(task: ITask, start: boolean) {
  try {
    const taskIndex = currentTasks.findIndex(t => t._id === task._id);

    if (taskIndex !== -1) {
      currentTasks[taskIndex].running = start;
    }
    console.log(GREEN + `Updated task ${task.contract.slug} running status to: ${start}`.toUpperCase() + RESET);

    if (task.outbidOptions.counterbid) {
      try {
        console.log("subscribing to collection: ", task.contract.slug);
        const newTask = { ...task, running: true };
        await subscribeToCollections([newTask]);
      } catch (error) {
        console.error(RED + `Error subscribing to collection ${task.contract.slug}:` + RESET, error);
      }
    }

    const jobs = [
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea") ? [{ name: OPENSEA_SCHEDULE, data: { ...task, running: start }, opts: { priority: COLLECTION_BID_PRIORITY.OPENSEA } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur") ? [{ name: BLUR_SCHEDULE, data: { ...task, running: start }, opts: { priority: COLLECTION_BID_PRIORITY.BLUR } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden") ? [{ name: MAGICEDEN_SCHEDULE, data: { ...task, running: start }, opts: { priority: COLLECTION_BID_PRIORITY.MAGICEDEN } }] : []),
    ];

    if (jobs.length > 0) {
      await processBulkJobs(jobs);
    }
  } catch (error) {
    console.error(RED + `Error starting task ${task.contract.slug}:` + RESET, error);
    throw error;
  }
}


async function stopTask(task: ITask, start: boolean, marketplace?: string) {
  const taskId = task._id.toString();

  try {
    await updateTaskStatus(task, start, marketplace);

    await removePendingAndWaitingBids(task, marketplace)
    await cancelAllRelatedBids(task, marketplace)
    await waitForRunningJobsToComplete(task, marketplace)

    // const cleanupOperations = [
    //   {
    //     name: 'Remove pending bids',
    //     operation: () => removePendingAndWaitingBids(task, marketplace)
    //   },
    //   {
    //     name: 'Cancel related bids',
    //     operation: () => cancelAllRelatedBids(task, marketplace)
    //   },
    //   {
    //     name: 'Wait for running jobs',
    //     operation: () => waitForRunningJobsToComplete(task, marketplace)
    //   },
    // ];

    // for (const { name, operation } of cleanupOperations) {
    //   try {
    //     await Promise.race([
    //       operation(),
    //       new Promise((_, reject) =>
    //         setTimeout(() => reject(new Error(`${name} timeout`)), STOP_TIMEOUT)
    //       )
    //     ]);
    //   } catch (error) {
    //     console.error(RED + `Error during ${name.toLowerCase()} for task ${task.contract.slug}:` + RESET, error);
    //   }
    // }

    if (task.outbidOptions.counterbid) {
      try {
        await unsubscribeFromCollection(task);
      } catch (error) {
        console.error(RED + `Error unsubscribing from collection for task ${task.contract.slug}:` + RESET, error);
      }
    }

    const residualBids = await checkForResidualBids(task, marketplace);
    if (residualBids.length > 0) {
      console.warn(YELLOW + `Found ${residualBids.length} residual bids after stopping task` + RESET);
      try {
        await Promise.race([
          cancelAllRelatedBids(task, marketplace),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Final cleanup timeout')), 30000)
          )
        ]);
      } catch (error) {
        console.error(RED + `Error during final cleanup for task ${task.contract.slug}:` + RESET, error);
      }
    }

    await Promise.all([
      redis.del(`opensea:${taskId}:count`),
      redis.del(`magiceden:${taskId}:count`),
      redis.del(`blur:${taskId}:count`)
    ]);

  } catch (error) {
    console.error(RED + `Error stopping task ${task.contract.slug}:` + RESET, error);
    throw error;
  } finally {
  }
}

async function checkForResidualBids(task: ITask, marketplace?: string): Promise<string[]> {
  const patterns = [];
  const taskId = task._id;

  if (!marketplace || marketplace.toLowerCase() === 'opensea') {
    patterns.push(`*:${taskId}:opensea:order:${task.contract.slug}:*`);
  }
  if (!marketplace || marketplace.toLowerCase() === 'blur') {
    patterns.push(`*:${taskId}:blur:order:${task.contract.slug}:*`);
  }
  if (!marketplace || marketplace.toLowerCase() === 'magiceden') {
    patterns.push(`*:${taskId}:magiceden:order:${task.contract.slug}:*`);
  }

  const results = await Promise.all(patterns.map(pattern => redis.keys(pattern)));
  return results.flat();
}

async function removePendingAndWaitingBids(task: ITask, marketplace?: string) {
  try {
    // Pause the queue before removing jobs
    await queue.pause();
    console.log(YELLOW + 'Queue paused while removing pending bids...'.toUpperCase() + RESET);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'failed', 'paused', 'prioritized', 'repeat', 'wait', 'waiting', 'waiting-children']);
    let jobnames: string[] = [OPENSEA_SCHEDULE, OPENSEA_TRAIT_BID, OPENSEA_TOKEN_BID, MAGICEDEN_SCHEDULE, MAGICEDEN_TRAIT_BID, MAGICEDEN_TOKEN_BID, BLUR_SCHEDULE, BLUR_TRAIT_BID]

    switch (marketplace?.toLowerCase()) {
      case OPENSEA.toLowerCase():
        jobnames = [OPENSEA_SCHEDULE, OPENSEA_TRAIT_BID, OPENSEA_TOKEN_BID]
        break;

      case MAGICEDEN.toLowerCase():
        jobnames = [MAGICEDEN_SCHEDULE, MAGICEDEN_TRAIT_BID, MAGICEDEN_TOKEN_BID]
        break;

      case BLUR.toLowerCase():
        jobnames = [BLUR_SCHEDULE, BLUR_TRAIT_BID]
        break;
      default:
        jobnames = [OPENSEA_SCHEDULE, OPENSEA_TRAIT_BID, OPENSEA_TOKEN_BID, MAGICEDEN_SCHEDULE, MAGICEDEN_TRAIT_BID, MAGICEDEN_TOKEN_BID, BLUR_SCHEDULE, BLUR_TRAIT_BID]
    }

    const relatedJobs = jobs.filter(job => {
      const matchesId = job?.data?._id === task?._id
      if (jobnames && jobnames.length > 0) {
        return matchesId && jobnames.includes(job.name);
      }
      return matchesId;
    });


    console.log();

    await Promise.all(relatedJobs.map(job => job.remove()));

    if (relatedJobs.length > 0) {
      console.log(RED + `Removed ${relatedJobs.length} pending and waiting bids for task: ${task.contract.slug}`.toUpperCase() + RESET);
    }

    // Resume the queue after removing jobs
    await queue.resume();
    console.log(GREEN + 'Queue resumed after removing pending bids'.toUpperCase() + RESET);
  } catch (error) {
    // Make sure to resume the queue even if there's an error
    await queue.resume();
    console.error(RED + `Error removing pending bids: ${error}` + RESET);
  }
}

async function waitForRunningJobsToComplete(task: ITask, marketplace?: string) {
  try {
    const checkInterval = 1000;
    let jobnames: string[] = [OPENSEA_SCHEDULE, OPENSEA_TRAIT_BID, OPENSEA_TOKEN_BID, MAGICEDEN_SCHEDULE, MAGICEDEN_TRAIT_BID, MAGICEDEN_TOKEN_BID, BLUR_SCHEDULE, BLUR_TRAIT_BID]

    switch (marketplace?.toLowerCase()) {
      case OPENSEA.toLowerCase():
        jobnames = [OPENSEA_SCHEDULE, OPENSEA_TRAIT_BID, OPENSEA_TOKEN_BID]
        break;

      case MAGICEDEN.toLowerCase():
        jobnames = [MAGICEDEN_SCHEDULE, MAGICEDEN_TRAIT_BID, MAGICEDEN_TOKEN_BID]
        break;

      case BLUR.toLowerCase():
        jobnames = [BLUR_SCHEDULE, BLUR_TRAIT_BID]
        break;
      default:
        jobnames = [OPENSEA_SCHEDULE, OPENSEA_TRAIT_BID, OPENSEA_TOKEN_BID, MAGICEDEN_SCHEDULE, MAGICEDEN_TRAIT_BID, MAGICEDEN_TOKEN_BID, BLUR_SCHEDULE, BLUR_TRAIT_BID]
    }

    // Pause the queue
    console.log(YELLOW + 'Pausing queue while waiting for running jobs to complete...'.toUpperCase() + RESET);
    await queue.pause();

    while (true) {
      const activeJobs = await queue.getJobs(['active']);
      const relatedJobs = activeJobs?.filter(job => {
        const matchedId = job?.data?._id === task._id
        if (jobnames && jobnames?.length > 0) {
          return matchedId && jobnames?.includes(job?.name);
        }
        return matchedId;
      });

      if (relatedJobs?.length === 0) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // Resume the queue
    console.log(GREEN + 'Resuming queue after running jobs completed...'.toUpperCase() + RESET);
    await queue.resume();

  } catch (error: any) {
    console.error(RED + `Error waiting for running jobs to complete for task ${task.contract.slug}: ${error.message}` + RESET);
    // Ensure the queue is resumed even if an error occurs
    await queue.resume();
  }
}

interface MarketplaceBids {
  marketplace: string;
  bids: string[];
  cancelFn: (bids: string[], privateKey: string, slug: string) => Promise<void>;
}

async function updateTaskStatus(task: ITask, running: boolean, marketplace?: string) {
  const taskIndex = currentTasks.findIndex(t => t._id === task._id);
  if (taskIndex !== -1) {
    if (marketplace) {
      return
    } else {
      currentTasks[taskIndex].running = running;
    }
  }
  console.log(running ? GREEN : RED + `${running ? 'Started' : 'Stopped'} processing task ${task.contract.slug}`.toUpperCase() + RESET);
}

async function cancelAllRelatedBids(task: ITask, marketplace?: string) {
  const { openseaBids, magicedenBids, blurBids } = await getAllRelatedBids(task);
  console.log(YELLOW + `Found bids to cancel for ${task.contract.slug}:`.toUpperCase() + RESET);
  if (openseaBids.length) console.log(`- OpenSea: ${openseaBids.length} bids`.toUpperCase());
  if (magicedenBids.length) console.log(`- MagicEden: ${magicedenBids.length} bids`.toUpperCase());
  if (blurBids.length) console.log(`- Blur: ${blurBids.length} bids`.toUpperCase());

  if (!marketplace) {
    await cancelOpenseaBids(openseaBids, task.wallet.privateKey, task.contract.slug, task);
    await cancelMagicedenBids(magicedenBids, task.wallet.privateKey, task.contract.slug, task);
    await cancelBlurBids(blurBids, task.wallet.privateKey, task.contract.slug, task);
  }

  switch (marketplace?.toLowerCase()) {
    case OPENSEA.toLowerCase():
      await cancelOpenseaBids(openseaBids, task.wallet.privateKey, task.contract.slug, task);
      break;

    case MAGICEDEN.toLowerCase():
      await cancelMagicedenBids(magicedenBids, task.wallet.privateKey, task.contract.slug, task);
      break;

    case BLUR.toLowerCase():
      await cancelBlurBids(blurBids, task.wallet.privateKey, task.contract.slug, task);
      break;

    default:
      await cancelOpenseaBids(openseaBids, task.wallet.privateKey, task.contract.slug, task);
      await cancelMagicedenBids(magicedenBids, task.wallet.privateKey, task.contract.slug, task);
      await cancelBlurBids(blurBids, task.wallet.privateKey, task.contract.slug, task);
  }

  const remainingBids = await getAllRelatedBids(task);
  const totalRemaining = [
    ...(marketplace?.toLowerCase() === OPENSEA.toLowerCase() || !marketplace ? remainingBids.openseaBids : []),
    ...(marketplace?.toLowerCase() === MAGICEDEN.toLowerCase() || !marketplace ? remainingBids.magicedenBids : []),
    ...(marketplace?.toLowerCase() === BLUR.toLowerCase() || !marketplace ? remainingBids.blurBids : [])
  ];

  if (totalRemaining.length > 0) {
    console.log(RED + `WARNING: Found ${totalRemaining.length} remaining bids after cancellation for ${task.contract.slug}:`.toUpperCase() + RESET);
    if (remainingBids.openseaBids.length) console.log(RED + `- OpenSea: ${remainingBids.openseaBids.length} bids` + RESET);
    if (remainingBids.magicedenBids.length) console.log(RED + `- MagicEden: ${remainingBids.magicedenBids.length} bids` + RESET);
    if (remainingBids.blurBids.length) console.log(RED + `- Blur: ${remainingBids.blurBids.length} bids` + RESET);

    console.log(RED + 'Attempting to cancel remaining bids...'.toUpperCase() + RESET);
    await cancelAllRelatedBids(task, marketplace);
  } else {
    console.log(GREEN + `Successfully cancelled all bids for ${task.contract.slug}`.toUpperCase() + RESET);
  }
}

async function getAllRelatedBids(task: ITask) {
  let openseaBids: string[] = [];
  let magicedenBids: string[] = [];
  let blurBids: string[] = [];
  const taskId = task._id

  const selectedTraits = transformNewTask(task.selectedTraits);

  if (task.bidType === "token") {
    openseaBids = await redis.keys(`*:${taskId}:opensea:order:${task.contract.slug}:[0-9]*`);
    magicedenBids = await redis.keys(`*:${taskId}:magiceden:order:${task.contract.slug}:[0-9]*`);
    blurBids = await redis.keys(`*:${taskId}:blur:order:${task.contract.slug}:[0-9]*`)
  } else if (task.bidType === "collection" && (!selectedTraits || (selectedTraits && Object.keys(selectedTraits).length === 0))) {
    openseaBids = await redis.keys(`*:${taskId}:opensea:order:${task.contract.slug}:default`);
    magicedenBids = await redis.keys(`*:${taskId}:magiceden:order:${task.contract.slug}:default`);
    blurBids = await redis.keys(`*:${taskId}:blur:order:${task.contract.slug}:default`)
  } else {
    openseaBids = await redis.keys(`*:${taskId}:opensea:order:${task.contract.slug}:*`);
    magicedenBids = await redis.keys(`*:${taskId}:magiceden:order:${task.contract.slug}:*`);
    blurBids = await redis.keys(`*:${taskId}:blur:order:${task.contract.slug}:*`)
  }

  return { openseaBids, magicedenBids, blurBids };
}

async function cancelOpenseaBids(bids: string[], privateKey: string, slug: string, task: ITask) {
  const bidData = await Promise.all(bids.map(key => redis.get(key)));
  const taskId = task._id
  if (bidData.length) { console.log(RED + `Found ${bidData.length} OpenSea bids to cancel for ${slug}`.toUpperCase() + RESET) }
  const cancelData = bidData.map(bid => ({
    name: CANCEL_OPENSEA_BID,
    data: { orderHash: bid, privateKey },
    opts: { priority: CANCEL_PRIORITY.OPENSEA }
  }));
  if (cancelData.length) {
    await processBulkJobs(cancelData);
  }


  const offerKeys = await redis.keys(`*:${taskId}:opensea:${slug}:*`);
  if (offerKeys.length) {
    await redis.del(...offerKeys);
  }

  await Promise.all(bids.map(key => redis.del(key)));
  const remainingOrderKeys = await redis.keys(`*:${taskId}:opensea:order:${slug}:*`);
  if (remainingOrderKeys.length > 0) {
    console.log(RED + `Found ${remainingOrderKeys.length} residual opensea bids for ${slug}, continuing cancellation...`.toUpperCase() + RESET);
    await cancelOpenseaBids(remainingOrderKeys, privateKey, slug, task);
  }
}

async function cancelMagicedenBids(orderKeys: string[], privateKey: string, slug: string, task: ITask) {
  if (!orderKeys.length) {
    return;
  }
  const bidData = await Promise.all(orderKeys.map(key => redis.get(key)));
  const taskId = task._id
  const extractedOrderIds = bidData
    .map(bid => {
      if (!bid) return null;
      try {
        const parsed = JSON.parse(bid);

        if (parsed.results) {
          return parsed.results[0].orderId;
        }
        if (parsed.message && parsed.orderId) {
          return parsed.orderId;
        }

        return null;
      } catch (e) {
        console.error('Error parsing bid data:', e);
        return null;
      }
    })
    .filter(id => id !== null);
  for (let i = 0; i < extractedOrderIds.length; i += 1000) {
    const batch = extractedOrderIds.slice(i, i + 1000);
    console.log(RED + `DELETING  batch ${Math.floor(i / 1000) + 1} of ${Math.ceil(extractedOrderIds.length / 1000)} (${batch.length} MAGICEDEN BIDS)`.toUpperCase() + RESET);
    await queue.add(CANCEL_MAGICEDEN_BID, { orderIds: batch, privateKey }, { priority: CANCEL_PRIORITY.MAGICEDEN });
  }
  const offerKeys = await redis.keys(`*:${taskId}:magiceden:${slug}:*`);
  if (offerKeys.length) {
    await redis.del(...offerKeys);
  }

  await Promise.all(orderKeys.map(key => redis.del(key)));

  const remainingOrderKeys = await redis.keys(`*:${taskId}:magiceden:order:${slug}:*`);
  if (remainingOrderKeys.length > 0) {
    console.log(RED + `Found ${remainingOrderKeys.length} residual MagicEden bids for ${slug}, continuing cancellation...`.toUpperCase() + RESET);
    await cancelMagicedenBids(remainingOrderKeys, privateKey, slug, task);
  }
}

async function cancelBlurBids(bids: any[], privateKey: string, slug: string, task: ITask) {
  const data = await Promise.all(bids.map((key) => redis.get(key)));

  const taskId = task._id
  if (!data) return
  const cancelData = data.map((bid) => {
    if (!bid) return
    const payload = JSON.parse(bid)
    return {
      name: CANCEL_BLUR_BID,
      data: { payload: payload, privateKey },
      opts: { priority: CANCEL_PRIORITY.BLUR }
    }
  }).filter((item): item is { name: string; data: any; opts: { priority: 1 } } => item !== undefined);

  if (cancelData.length) {
    await processBulkJobs(cancelData);
  }
  const offerKeys = await redis.keys(`*:${taskId}:blur:${slug}:*`);
  if (offerKeys.length) {
    await redis.del(...offerKeys);
  }
  await Promise.all(bids.map(key => redis.del(key)));

  const remainingOrderKeys = await redis.keys(`*:${taskId}:blur:order:${slug}:*`);
  if (remainingOrderKeys.length > 0) {
    console.log(RED + `Found ${remainingOrderKeys.length} residual Blur bids for ${slug}, continuing cancellation...`.toUpperCase() + RESET);
    await cancelBlurBids(remainingOrderKeys, privateKey, slug, task);
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

async function unsubscribeFromCollection(task: ITask) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket is not open for unsubscribing from collection: ${task.contract.slug}`);
    }

    const unsubscribeMessage = {
      "slug": task.contract.slug,
      "topic": task.contract.slug,
      "contractAddress": task.contract.contractAddress,
      "event": "leave_the_party",
      "clientId": task.user.toString(),
    };

    await new Promise<void>((resolve, reject) => {
      try {
        ws.send(JSON.stringify(unsubscribeMessage));
        console.log(`Unsubscribed from collection: ${task.contract.slug}`);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  } catch (error) {
    console.error(RED + `Error in unsubscribeFromCollection:` + RESET, error);
    throw error;
  }
}

async function updateMarketplace(task: ITask) {
  try {
    const { _id: taskId, selectedMarketplaces: newMarketplaces } = task;
    const taskIndex = currentTasks?.findIndex(task => task?._id === taskId);

    if (taskIndex === -1) return;

    const currentMarketplaces = currentTasks[taskIndex].selectedMarketplaces;
    const currentSet = new Set(currentMarketplaces.map(m => m.toLowerCase()));
    const newSet = new Set(newMarketplaces.map(m => m.toLowerCase()));

    const outgoing = Array.from(currentSet).find(m => !newSet.has(m));
    const incoming = Array.from(newSet).find(m => !currentSet.has(m));

    if (outgoing) {
      console.log(RED + `Removing marketplace: ${outgoing.toUpperCase()} for collection: ${task.contract.slug}`.toUpperCase() + RESET);
    }

    currentTasks[taskIndex] = {
      ...currentTasks[taskIndex],
      selectedMarketplaces: [...newMarketplaces]
    };

    if (outgoing) {
      await handleOutgoingMarketplace(outgoing, task);
    }

    if (incoming) {
      const color = incoming.toLowerCase() === "magiceden" ? MAGENTA :
        incoming.toLowerCase() === "blur" ? GOLD : BLUE;

      console.log(color + `Adding marketplace: ${incoming.toUpperCase()} for collection: ${task.contract.slug}`.toUpperCase() + RESET);

      switch (incoming.toLowerCase()) {
        case "opensea":
          await queue.add(OPENSEA_SCHEDULE, task, { priority: COLLECTION_BID_PRIORITY.OPENSEA });
          break;
        case "magiceden":
          await queue.add(MAGICEDEN_SCHEDULE, task, { priority: COLLECTION_BID_PRIORITY.MAGICEDEN });
          break;
        case "blur":
          await queue.add(BLUR_SCHEDULE, task, { priority: COLLECTION_BID_PRIORITY.BLUR });
          break;
      }
    }

  } catch (error) {
    console.error(RED + `Error updating marketplace for task: ${task._id}` + RESET, error);
  }
}

async function handleOutgoingMarketplace(marketplace: string, task: ITask) {
  try {
    const config = getMarketplaceConfig(marketplace.toLowerCase());
    if (!config) return;
    const countKey = `${marketplace}:${task._id}:count`;
    await redis.del(countKey);

    await stopTask(task, false, marketplace);

    // Double check for residual bids after a short delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    const residualBids = await checkForResidualBids(task, marketplace);

    if (residualBids.length > 0) {
      console.warn(YELLOW + `Found ${residualBids.length} residual bids after marketplace removal, attempting final cleanup...` + RESET);
      await stopTask(task, false, marketplace);
    }

  } catch (error) {
    console.error(RED + `Failed to handle outgoing marketplace ${marketplace} for task ${task.contract.slug}:` + RESET, error);
  }
}

function getMarketplaceConfig(marketplace: string) {
  const configs: any = {
    'opensea': {
      jobTypes: [OPENSEA_SCHEDULE, OPENSEA_TRAIT_BID, OPENSEA_TOKEN_BID],
      cancelJobType: CANCEL_OPENSEA_BID,
    },
    'blur': {
      jobTypes: [BLUR_SCHEDULE, BLUR_TRAIT_BID],
      cancelJobType: CANCEL_BLUR_BID,
    },
    'magiceden': {
      jobTypes: [MAGICEDEN_SCHEDULE, MAGICEDEN_TRAIT_BID, MAGICEDEN_TOKEN_BID],
      cancelJobType: CANCEL_MAGICEDEN_BID,
    }
  } as const;
  return configs[marketplace];
}

async function updateMultipleTasksStatus(data: { tasks: ITask[], running: boolean }) {
  try {
    const { tasks, running } = data;

    if (running) {
      await Promise.all(tasks.map(async (task) => {
        try {
          await startTask(task, true);
        } catch (error) {
          console.error(RED + `Error starting task ${task.contract.slug}:` + RESET, error);
        }
      }));
    } else {
      await Promise.all(tasks.map(async (task) => {
        try {
          await stopTask(task, false);
        } catch (error) {
          console.error(RED + `Error stopping task ${task.contract.slug}:` + RESET, error);
        }
      }));
    }
  } catch (error) {
    console.error(RED + 'Error updating multiple tasks status:' + RESET, error);
  }
}

function connectWebSocket(): void {

  ws = new WebSocket(MARKETPLACE_WS_URL);
  ws.addEventListener("open", function open() {
    console.log(GOLD + "CONNECTED TO MARKETPLACE EVENTS WEBSCKET" + RESET);
    retryCount = 0;
    if (reconnectTimeoutId !== null) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
    if (heartbeatIntervalId !== null) {
      clearInterval(heartbeatIntervalId);
    }

    const clientId = currentTasks.length > 0 && currentTasks[0]?.user
      ? currentTasks[0].user.toString()
      : "nfttools-default-client";

    heartbeatIntervalId = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            event: "ping",
            clientId
          })
        );
      }
    }, 30000);

    if (currentTasks.length > 0) {
      subscribeToCollections(currentTasks as unknown as ITask[])
    }


    if (currentTasks.length > 0) {
      subscribeToCollections(currentTasks as unknown as ITask[])
    }

    ws.on("message", async function incoming(data: string) {
      try {
        const message = JSON.parse(data.toString())
        await handleCounterBid(message);
      } catch (error) {
        console.log(error);
      }
    });
  });

  ws.addEventListener("close", function close() {
    console.log(RED + "DISCONNECTED FROM MARKETPLACE EVENTS WEBSCKET" + RESET);
    if (heartbeatIntervalId !== null) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
    attemptReconnect();
  });

  ws.addEventListener("error", function error(err) {
    console.error(RED + "WebSocket connection error:" + RESET, err);
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

async function handleCounterBid(message: any) {
  const { contractAddress, slug } = getMarketplaceDetails(message);

  if (!contractAddress && !slug) return;

  const relevantTasks = currentTasks.filter(task =>
    task.outbidOptions.counterbid &&
    task.running &&
    (task.contract.contractAddress.toLowerCase() === contractAddress?.toLowerCase() ||
      task.contract.slug.toLowerCase() === slug?.toLowerCase())
  );

  if (!relevantTasks.length) return;

  await Promise.all(relevantTasks.map(task => handleCounterBidForTask(task, message)));
}

function getMarketplaceDetails(message: any): { contractAddress?: string, slug?: string } {
  switch (message.marketplace) {
    case BLUR:
      return { contractAddress: handleBlurMessages(message) };
    case OPENSEA:
      return handleOpenSeaMessages(message);
    case MAGICEDEN:
      return handleMagicEdenMessages(message);
    default:
      console.log(`Unknown marketplace: ${message.marketplace}`);
      return {};
  }
}

async function handleCounterBidForTask(task: any, message: any) {
  const selectedMarketplaces = task.selectedMarketplaces.map((m: string) => m.toLowerCase());

  if (selectedMarketplaces.includes('blur') && message.marketplace === BLUR) {
    await handleBlurCounterbid(message['1'], task);
  }

  if (selectedMarketplaces.includes('opensea') && message.marketplace === OPENSEA) {
    await handleOpenseaCounterbid(message, task);
  }

  if (selectedMarketplaces.includes('magiceden') && message.marketplace === MAGICEDEN) {
    await handleMagicEdenCounterbid(message, task)
  }
}


async function handleMagicEdenCounterbid(data: any, task: ITask) {
  try {

    const domain: string = data?.data?.source?.domain
    if (!domain.includes("magiceden")) return

    const maker = data?.data?.maker?.toLowerCase()
    if (maker === task.wallet.address.toLowerCase()) return

    const expiry = getExpiry(task.bidDuration)
    const duration = expiry / 60 || 15;
    const currentTime = new Date().getTime();
    const expiration = Math.floor((currentTime + (duration * 60 * 1000)) / 1000);
    const floor_price = await fetchMagicEdenCollectionStats(task.contract.contractAddress)

    if (floor_price === 0 || !floor_price) return

    const { maxBidPriceEth } = calculateBidPrice(task, floor_price as number, "magiceden")
    const magicedenOutbidMargin = task.outbidOptions.magicedenOutbidMargin || 0.0001

    const bidType = data?.data?.criteria?.kind
    const tokenId = +data?.data?.criteria?.data?.token?.tokenId;

    let redisKey: string;
    let currentBidPrice: number | string;
    const incomingPrice = Number(data?.data?.price?.amount?.raw);
    let offerPrice: number;

    const selectedTraits = transformNewTask(task.selectedTraits)


    if (bidType === "token") {
      console.log(BLUE + '----------------------------------------------------------------------------------' + RESET);
      console.log(BLUE + `incoming bid for ${task.contract.slug}:${tokenId} for ${incomingPrice / 1e18} WETH on magiceden`.toUpperCase() + RESET);
      console.log(BLUE + '----------------------------------------------------------------------------------' + RESET);

      console.log(BLUE + JSON.stringify(data) + RESET);

      const autoIds = task.tokenIds
        .filter(id => id.toString().toLowerCase().startsWith('bot'))
        .map(id => {
          const matches = id.toString().match(/\d+/);
          return matches ? parseInt(matches[0]) : null;
        })
        .filter(id => id !== null);

      if (!autoIds.includes(tokenId)) return

      redisKey = `magiceden:${task.contract.slug}:${tokenId}`;
      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)


      if (incomingPrice < currentBidPrice) return

      offerPrice = Math.ceil((magicedenOutbidMargin * 1e18) + incomingPrice)
      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `magiceden counter offer ${offerPrice / 1e18} WETH for ${task.contract.slug} ${tokenId}  exceeds max bid price ${maxBidPriceEth} WETH ON MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming magiceden offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug} ${tokenId} for ${Number(offerPrice) / 1e18} WETH ON MAGICEDEN`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);

      await processMagicedenTokenBid({
        _id: task._id,
        address: task.wallet.address,
        contractAddress: task.contract.contractAddress,
        quantity: 1,
        offerPrice: offerPrice.toString(),
        expiration: expiration.toString(),
        privateKey: task.wallet.privateKey,
        slug: task.contract.slug,
        tokenId: tokenId,
        outbidOptions: task.outbidOptions,
        maxBidPriceEth
      })
    }
    if (bidType === "attribute") {

      const traitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0
      const trait = {
        attributeKey: data?.data?.criteria?.data?.attribute?.key,
        attributeValue: data?.data?.criteria?.data?.attribute?.value,
      }

      const hasTraits = checkMagicEdenTrait(selectedTraits, trait)
      if (!hasTraits || !traitBid) return

      console.log(GREEN + '----------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `incoming bid for ${task.contract.slug}:${JSON.stringify(trait)} for ${incomingPrice / 1e18} WETH on magiceden`.toUpperCase() + RESET);
      console.log(GREEN + '----------------------------------------------------------------------------------' + RESET);

      redisKey = `magiceden:${task.contract.slug}:${trait}`;
      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)

      if (incomingPrice < currentBidPrice) return

      offerPrice = Math.ceil((magicedenOutbidMargin * 1e18) + incomingPrice)
      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer ${offerPrice / 1e18} WETH for ${task.contract.slug} ${trait} exceeds max bid price ${maxBidPriceEth} WETH ON MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug} ${JSON.stringify(trait)} for ${Number(offerPrice) / 1e18} WETH ON MAGICEDEN `.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);

      await processMagicedenTraitBid({
        _id: task._id,
        address: task.wallet.address,
        contractAddress: task.contract.contractAddress,
        quantity: 1,
        offerPrice: offerPrice.toString(),
        expiration: expiration.toString(),
        privateKey: task.wallet.privateKey,
        slug: task.contract.slug,
        trait: trait
      })
    }
    if (bidType === "collection") {
      console.log(GOLD + JSON.stringify(data) + RESET);
      if (maker === task.wallet.address.toLowerCase()) return

      const isTraitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0
      const tokenBid = task.bidType === "token" && task.tokenIds.length > 0
      const collectionBid = !isTraitBid && !tokenBid

      if (!collectionBid) return

      console.log(GREEN + '----------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `incoming collection offer for ${task.contract.slug} for ${incomingPrice / 1e18} WETH on magiceden`.toUpperCase() + RESET);
      console.log(GREEN + '----------------------------------------------------------------------------------' + RESET);

      redisKey = `magiceden:${task.contract.slug}:collection`;
      currentBidPrice = await redis.get(redisKey) || 0

      currentBidPrice = Number(currentBidPrice)
      if (incomingPrice < currentBidPrice) return
      offerPrice = Math.ceil((magicedenOutbidMargin * 1e18) + incomingPrice)

      if (maxBidPriceEth > 0 && Number(offerPrice) / 1e18 > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer ${offerPrice / 1e18} WETH for ${task.contract.slug}  exceeds max bid price ${maxBidPriceEth} WETH. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming magiceden offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug} for ${Number(offerPrice) / 1e18} WETH`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);

      const bidCount = await getIncrementedBidCount(MAGICEDEN, task.contract.slug, task._id)
      await bidOnMagiceden(task._id, bidCount, task.wallet.address, task.contract.contractAddress, 1, offerPrice.toString(), task.wallet.privateKey, task.contract.slug);
    }
  } catch (error) {
    console.error(RED + `Error handling MAGICEDEN counterbid: ${JSON.stringify(error)}` + RESET);
  }
}

async function handleOpenseaCounterbid(data: any, task: ITask) {
  try {
    const maker = data?.payload?.payload?.maker?.address.toLowerCase()
    const incomingPrice: number = Number(data?.payload?.payload?.base_price);

    if (maker === task.wallet.address.toLowerCase()) return

    const expiry = getExpiry(task.bidDuration)
    const stats = await getCollectionStats(task.contract.slug);
    const floor_price = stats.total.floor_price;

    if (floor_price === 0) return

    const { maxBidPriceEth } = calculateBidPrice(task, floor_price, "opensea")
    const openseaOutbidMargin = task.outbidOptions.openseaOutbidMargin || 0.0001

    const collectionDetails = await getCollectionDetails(task.contract.slug);
    const creatorFees: IFee = collectionDetails.creator_fees.null !== undefined
      ? { null: collectionDetails.creator_fees.null }
      : Object.fromEntries(Object.entries(collectionDetails.creator_fees).map(([key, value]) => [key, Number(value)]));


    let redisKey: string;
    let currentBidPrice: number | string;
    let offerPrice: number;
    let colletionOffer: bigint;

    const selectedTraits = transformNewTask(task.selectedTraits)

    if (data.event === "item_received_bid") {
      const tokenId = +data.payload.payload.protocol_data.parameters.consideration.find((item: any) => item.token.toLowerCase() === task.contract.contractAddress.toLowerCase()).identifierOrCriteria
      const tokenIds = task.tokenIds.filter(id => id.toString().toLowerCase().startsWith('bot'));

      if (!tokenIds.includes(tokenId)) return

      console.log(BLUE + '---------------------------------------------------------------------------------' + RESET);
      console.log(BLUE + `incoming offer for ${task.contract.slug}:${tokenId} for ${incomingPrice / 1e18} WETH on opensea`.toUpperCase() + RESET);
      console.log(BLUE + '---------------------------------------------------------------------------------' + RESET);

      redisKey = `opensea:${task.contract.slug}:${tokenId}`;

      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)
      if (incomingPrice < currentBidPrice) return

      offerPrice = Math.ceil((openseaOutbidMargin * 1e18) + incomingPrice)

      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter offer ${offerPrice / 1e18} WETH for ${task.contract.slug}:${tokenId}  exceeds max bid price ${maxBidPriceEth} WETH ON OPENSEA. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }
      colletionOffer = BigInt(offerPrice)

      const asset = {
        contractAddress: task.contract.contractAddress,
        tokenId: tokenId
      }

      const bidCount = await getIncrementedBidCount(OPENSEA, task.contract.slug, task._id)
      await bidOnOpensea(
        task._id,
        bidCount,
        task.wallet.address,
        task.wallet.privateKey,
        task.contract.slug,
        colletionOffer,
        creatorFees,
        collectionDetails.enforceCreatorFee,
        expiry,
        undefined,
        asset
      )
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, colletionOffer.toString());

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming opensea offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug}:${asset.tokenId} for ${Number(colletionOffer) / 1e18} WETH ON OPENSEA`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
    }
    if (data.event === "trait_offer") {
      const traitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0
      const hasTraits = checkOpenseaTrait(selectedTraits, data.payload.payload.trait_criteria)

      if (!hasTraits || !traitBid) return

      const trait = JSON.stringify({
        type: data.payload.payload.trait_criteria.trait_type,
        value: data.payload.payload.trait_criteria.trait_name
      })

      console.log(GREEN + '---------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `incoming offer for ${task.contract.slug}:${trait} for ${incomingPrice / 1e18} WETH on opensea`.toUpperCase() + RESET);
      console.log(GREEN + '---------------------------------------------------------------------------------' + RESET);

      redisKey = `opensea:${task.contract.slug}:${trait}`;
      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)

      if (incomingPrice < currentBidPrice) return

      offerPrice = Math.ceil((openseaOutbidMargin * 1e18) + incomingPrice)

      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer ${offerPrice / 1e18} WETH for ${task.contract.slug} ${trait}  exceeds max bid price ${maxBidPriceEth} WETH ON OPENSEA. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }
      colletionOffer = BigInt(offerPrice)
      const bidCount = await getIncrementedBidCount(OPENSEA, task.contract.slug, task._id)
      await bidOnOpensea(
        task._id,
        bidCount,
        task.wallet.address,
        task.wallet.privateKey,
        task.contract.slug,
        colletionOffer,
        creatorFees,
        collectionDetails.enforceCreatorFee,
        expiry,
        trait
      );
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming opensea offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug} ${trait} for ${Number(colletionOffer) / 1e18} WETH ON OPENSEA`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, offerPrice.toString());
    }
    if (data.event === "collection_offer") {

      const isTraitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0
      const tokenBid = task.bidType === "token" && task.tokenIds.length > 0
      const collectionBid = !isTraitBid && !tokenBid

      if (!collectionBid) return

      console.log(GOLD + '---------------------------------------------------------------------------------' + RESET);
      console.log(GOLD + `incoming collection offer for ${task.contract.slug} for ${incomingPrice / 1e18} WETH on opensea`.toUpperCase() + RESET);
      console.log(GOLD + '---------------------------------------------------------------------------------' + RESET);

      redisKey = `opensea:${task.contract.slug}:collection`;
      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)

      if (incomingPrice < currentBidPrice) return
      offerPrice = Math.ceil((openseaOutbidMargin * 1e18) + incomingPrice)

      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer price ${offerPrice / 1e18} WETH for ${task.contract.slug} exceeds max bid price ${maxBidPriceEth} WETH ON OPENSEA. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }
      colletionOffer = BigInt(offerPrice)
      const bidCount = await getIncrementedBidCount(OPENSEA, task.contract.slug, task._id)

      await bidOnOpensea(
        task._id,
        bidCount,
        task.wallet.address,
        task.wallet.privateKey,
        task.contract.slug,
        colletionOffer,
        creatorFees,
        collectionDetails.enforceCreatorFee,
        expiry,
        undefined,
        undefined,
      );

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug} for ${Number(colletionOffer) / 1e18} WETH ON OPENSEA`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
    }
  } catch (error) {
    console.error(RED + `Error handling OPENSEA counterbid: ${JSON.stringify(error)}` + RESET);
  }
}

async function handleBlurCounterbid(data: any, task: ITask) {
  const incomingBid: CombinedBid = data
  console.log(GOLD + JSON.stringify(data) + RESET);
  try {
    const expiry = getExpiry(task.bidDuration)
    const floor_price = await fetchBlurCollectionStats(task.contract.slug)

    if (floor_price === 0) return

    const { maxBidPriceEth } = calculateBidPrice(task, floor_price, "blur")

    const selectedTraits = transformNewTask(task.selectedTraits)

    const traitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0
    const blurOutbidMargin = task.outbidOptions.blurOutbidMargin || 0.01

    if (traitBid) {
      const traits = transformBlurTraits(selectedTraits)
      const incomingTraitBids = incomingBid?.stats?.filter(item => item.criteriaType.toLowerCase() === "trait") || incomingBid?.updates?.filter(item => item.criteriaType.toLowerCase() === "trait")
      const hasMatchingTraits = checkBlurTraits(incomingTraitBids, traits);

      if (!hasMatchingTraits.length) return
      for (const traitBid of hasMatchingTraits) {
        const trait = JSON.stringify(traitBid.criteriaValue)
        const redisKey = `blur:${task.contract.slug}:${trait}`;
        let currentBidPrice: string | number = await redis.get(redisKey) || 0
        currentBidPrice = Number(currentBidPrice) / 1e18
        if (!currentBidPrice) return
        const incomingPrice = Number(traitBid.bestPrice)
        if (incomingPrice <= currentBidPrice) return
        const offerPrice = Math.ceil(blurOutbidMargin + Number(incomingPrice))

        if (offerPrice > maxBidPriceEth) {
          console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
          console.log(RED + `counter Offer price ${offerPrice} BETH exceeds max bid price ${maxBidPriceEth} BETH ON BLUR. Skipping ...`.toUpperCase() + RESET);
          console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
          return;
        }

        await processBlurTraitBid({
          _id: task._id,
          contractAddress: task.contract.contractAddress,
          privateKey: task.wallet.privateKey,
          address: task.wallet.address,
          offerPrice: offerPrice.toString(),
          slug: task.contract.slug,
          trait: JSON.stringify(trait),
          expiry,
          outbidOptions: task.outbidOptions,
          maxBidPriceEth: maxBidPriceEth
        })
      }

    } else {
      const incomingPrice = incomingBid?.stats ?
        +incomingBid?.stats?.filter(item => item.criteriaType.toLowerCase() === "collection").sort((a, b) => +b.bestPrice - +a.bestPrice)[0].bestPrice
        : +incomingBid?.updates?.filter(item => item.criteriaType.toLowerCase() === "collection").sort((a, b) => +b.price - +a.price)[0].price

      const redisKey = `blur:${task.contract.slug}:collection`;
      let currentBidPrice: string | number = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice) / 1e18
      if (!currentBidPrice) return

      if (incomingPrice <= currentBidPrice) return

      const rawPrice = Math.ceil(blurOutbidMargin + Number(incomingPrice) * 1e18)
      const offerPrice = BigInt(Math.round(rawPrice / 1e16) * 1e16)

      if (maxBidPriceEth > 0 && offerPrice > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer price ${offerPrice} BETH exceeds max bid price ${maxBidPriceEth} BETH ON BLUR. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }

      const bidCount = await getIncrementedBidCount(BLUR, task.contract.slug, task._id)
      await bidOnBlur(task._id, bidCount, task.wallet.address, task.wallet.privateKey, task.contract.contractAddress, offerPrice, task.contract.slug, expiry);
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, offerPrice.toString());
    }

  } catch (error) {
    console.error(RED + `Error handling Blur counterbid: ${JSON.stringify(error)}` + RESET);
  }
}

function handleMagicEdenMessages(message: any) {
  let slug, contractAddress;
  try {
    if (
      typeof message === "object" && message.event === "bid.created"
    ) {
      slug = message.payload?.payload?.collection?.slug;
      contractAddress = message.tags?.contract || message.payload?.payload?.asset_contract_criteria?.address;
    }
  } catch (error) {
    console.error("Error parsing MagicEden message:", error);
  }
  return { contractAddress, slug }
}

function handleOpenSeaMessages(message: any) {
  let contractAddress, slug

  try {
    if (
      typeof message === "object" &&
      (message.event === "item_received_bid" ||
        message.event === "trait_offer" ||
        message.event === "collection_offer"
      )
    ) {
      slug = message.payload?.payload?.collection?.slug;
      contractAddress = message.payload?.payload?.asset_contract_criteria?.address;
    }
  } catch (err) {
    console.error("Error parsing OpenSea message:", err);
  }
  return { contractAddress, slug }
}

function handleBlurMessages(message: any) {
  let contractAddress: string | undefined;
  try {
    contractAddress = message['1'].contractAddress;
  } catch (error) {
    console.error(`Failed to parse Blur message:`, error);
  }
  return contractAddress
}

async function processOpenseaScheduledBid(task: ITask) {
  try {
    if (!task.running || !task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("opensea")) return

    const filteredTasks = Object.fromEntries(
      Object.entries(task?.selectedTraits || {}).map(([category, traits]) => [
        category,

        traits.filter(trait => trait.availableInMarketplaces.includes("opensea"))
      ]).filter(([_, traits]) => traits.length > 0)
    );

    const selectedTraits = transformNewTask(filteredTasks)
    const expiry = getExpiry(task.bidDuration)
    const WALLET_ADDRESS: string = task.wallet.address;
    const WALLET_PRIVATE_KEY: string = task.wallet.privateKey;
    const collectionDetails = await getCollectionDetails(task.contract.slug);
    const traitBid = selectedTraits && Object.keys(selectedTraits).length > 0

    const stats = await getCollectionStats(task.contract.slug);
    const floor_price = stats?.total?.floor_price || 0;

    const autoIds = task.tokenIds
      .filter(id => id.toString().toLowerCase().startsWith('bot'))
      .map(id => {
        const matches = id.toString().match(/\d+/);
        return matches ? parseInt(matches[0]) : null;
      })
      .filter(id => id !== null);

    const bottlomListing = await fetchOpenseaListings(task.contract.slug, autoIds[0]) ?? []
    const taskTokenIds = task.tokenIds

    const tokenIds = [...bottlomListing, ...taskTokenIds]
    const tokenBid = task.bidType === "token" && tokenIds.length > 0

    if (traitBid && !collectionDetails.trait_offers_enabled && !tokenBid) {
      console.log(RED + `Trait bidding is not available for ${task.contract.slug} on OpenSea.`.toUpperCase() + RESET);
      return;
    }

    if (floor_price === 0) return

    console.log(BLUE + `Current OPENSEA floor price for ${task.contract.slug}: ${floor_price} ETH`.toUpperCase() + RESET);

    const { offerPriceEth, maxBidPriceEth } = calculateBidPrice(task, floor_price, "opensea")

    const approved = await approveMarketplace(WETH_CONTRACT_ADDRESS, SEAPORT, task, maxBidPriceEth);

    if (!approved) return

    let offerPrice = BigInt(Math.ceil(offerPriceEth * 1e18));
    const creatorFees: IFee = collectionDetails.creator_fees.null !== undefined
      ? { null: collectionDetails.creator_fees.null }
      : Object.fromEntries(Object.entries(collectionDetails.creator_fees).map(([key, value]) => [key, Number(value)]));

    if (tokenBid) {
      const jobs = tokenIds
        .filter(token => !isNaN(Number(token)))
        .map((token) => ({
          name: OPENSEA_TOKEN_BID,
          data: {
            _id: task._id,
            address: WALLET_ADDRESS,
            privateKey: WALLET_PRIVATE_KEY,
            slug: task.contract.slug,
            offerPrice: offerPrice.toString(),
            creatorFees,
            enforceCreatorFee: collectionDetails.enforceCreatorFee,
            asset: { contractAddress: task.contract.contractAddress, tokenId: token },
            expiry,
            outbidOptions: task.outbidOptions,
            maxBidPriceEth: maxBidPriceEth
          },
          opts: { priority: TOKEN_BID_PRIORITY.OPENSEA }
        }));
      // await processBulkJobs(jobs);

      await processBulkJobs(jobs);
      console.log(`ADDED ${jobs.length} ${task.contract.slug} OPENSEA TOKEN BID JOBS TO QUEUE`);
    } else if (traitBid && collectionDetails.trait_offers_enabled) {
      const traits = transformOpenseaTraits(selectedTraits);
      const traitJobs = traits.map((trait) => ({
        name: OPENSEA_TRAIT_BID,
        data: {
          _id: task._id,
          address: WALLET_ADDRESS,
          privateKey: WALLET_PRIVATE_KEY,
          slug: task.contract.slug,
          contractAddress: task.contract.contractAddress,
          offerPrice: offerPrice.toString(),
          creatorFees,
          enforceCreatorFee: collectionDetails.enforceCreatorFee,
          trait: JSON.stringify(trait),
          expiry,
          outbidOptions: task.outbidOptions,
          maxBidPriceEth: maxBidPriceEth
        },
        opts: { priority: TRAIT_BID_PRIORITY.OPENSEA }
      }));

      await processBulkJobs(traitJobs);
      console.log(`ADDED ${traitJobs.length} ${task.contract.slug} OPENSEA TRAIT BID JOBS TO QUEUE`);
    } else if (task.bidType.toLowerCase() === "collection" && !traitBid) {
      if (task.outbidOptions.outbid) {
        let highestBids = await fetchOpenseaOffers(task.wallet.address, "COLLECTION", task.contract.slug, task.contract.contractAddress, {})
        highestBids = Number(highestBids)
        const outbidMargin = (task.outbidOptions.openseaOutbidMargin || 0.0001) * 1e18
        const bidPrice = !highestBids ? Number(offerPrice) : highestBids + outbidMargin
        offerPrice = BigInt(Math.ceil(bidPrice))
      }
      if (task.outbidOptions.outbid && maxBidPriceEth > 0 && Number(offerPrice) / 1e18 > maxBidPriceEth) {

        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `Offer price ${Number(offerPrice) / 1e18} ETH for ${task.contract.slug} exceeds max bid price ${maxBidPriceEth} ETH FOR OPENSEA. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        return
      }

      const redisKey = `opensea:${task.contract.slug}:collection`;
      const bidCount = await getIncrementedBidCount(OPENSEA, task.contract.slug, task._id)
      await bidOnOpensea(
        task._id,
        bidCount,
        WALLET_ADDRESS,
        WALLET_PRIVATE_KEY,
        task.contract.slug,
        offerPrice,
        creatorFees,
        collectionDetails.enforceCreatorFee,
        expiry,
        undefined,
        undefined,
      );
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, offerPrice.toString());
    }
  } catch (error) {
    console.error(RED + `Error processing OpenSea scheduled bid for task: ${task._id}` + RESET, error);
  }
}

async function processBlurScheduledBid(task: ITask) {
  try {
    if (!task.running || !task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("blur")) return

    const filteredTasks = Object.fromEntries(
      Object.entries(task?.selectedTraits || {}).map(([category, traits]) => [
        category,
        traits.filter(trait => trait.availableInMarketplaces
          .map((item) => item.toLowerCase())
          .includes("blur"))
      ]).filter(([_, traits]) => traits.length > 0)
    );
    const tokenBid = task.bidType === "token"
    if (tokenBid) return
    const expiry = getExpiry(task.bidDuration)
    const WALLET_ADDRESS: string = task.wallet.address;
    const WALLET_PRIVATE_KEY: string = task.wallet.privateKey;
    const selectedTraits = transformNewTask(filteredTasks)

    const traitBid = selectedTraits && Object.keys(selectedTraits).length > 0
    const outbidMargin = task.outbidOptions.blurOutbidMargin || 0.01
    const floor_price = await fetchBlurCollectionStats(task.contract.slug)

    if (floor_price === 0) return

    console.log(GOLD + `Current BLUR floor price for ${task.contract.slug}: ${floor_price} ETH`.toUpperCase() + RESET);

    const { offerPriceEth, maxBidPriceEth } = calculateBidPrice(task, floor_price, "blur")

    let offerPrice = BigInt(Math.round(offerPriceEth * 1e18 / 1e16) * 1e16);
    const contractAddress = task.contract.contractAddress

    if (traitBid) {
      const traits = transformBlurTraits(selectedTraits)
      const traitJobs = traits.map((trait) => ({
        name: BLUR_TRAIT_BID,
        data: {
          _id: task._id,
          address: WALLET_ADDRESS,
          privateKey: WALLET_PRIVATE_KEY,
          contractAddress,
          offerPrice: offerPrice.toString(),
          slug: task.contract.slug,
          trait: JSON.stringify(trait),
          expiry,
          outbidOptions: task.outbidOptions,
          maxBidPriceEth: maxBidPriceEth
        },
        opts: { priority: TRAIT_BID_PRIORITY.BLUR }
      }));

      // await processBulkJobs(traitJobs);

      await processBulkJobs(traitJobs);
      console.log(`ADDED ${traitJobs.length} ${task.contract.slug} BLUR TRAIT BID JOBS TO QUEUE`);
    } else if (task.bidType.toLowerCase() === "collection" && !traitBid) {
      if (task.outbidOptions.outbid) {
        const bids = await fetchBlurBid(task.contract.slug, "COLLECTION", {})
        const highestBids = Number(bids?.priceLevels.sort((a, b) => +b.price - +a.price)[0].price)
        const bidPrice = highestBids + outbidMargin
        offerPrice = BigInt(Math.ceil(Number(bidPrice) * 1e18))
      }

      if (task.outbidOptions.outbid && maxBidPriceEth > 0 && Number(offerPrice) / 1e18 > maxBidPriceEth) {
        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `Offer price ${Number(offerPrice) / 1e18} ETH for ${task.contract.slug} exceeds max bid price ${maxBidPriceEth} ETH FOR BLUR. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        return
      }

      const bidCount = await getIncrementedBidCount(BLUR, task.contract.slug, task._id)
      await bidOnBlur(task._id, bidCount, WALLET_ADDRESS, WALLET_PRIVATE_KEY, contractAddress, offerPrice, task.contract.slug, expiry);
      const redisKey = `blur:${task.contract.slug}:collection`;
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, offerPrice.toString());
    }
  } catch (error) {
    console.error(RED + `Error processing Blur scheduled bid for task: ${task._id}` + RESET, error);
  }
}

async function processOpenseaTraitBid(data: {
  _id: string
  address: string;
  privateKey: string;
  slug: string;
  contractAddress: string;
  offerPrice: string;
  creatorFees: IFee;
  enforceCreatorFee: boolean;
  trait: string;
  expiry: number;
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  }
  maxBidPriceEth: number;
}) {
  try {
    const { address, privateKey, slug, offerPrice, creatorFees, enforceCreatorFee, trait, expiry, outbidOptions, maxBidPriceEth, contractAddress, _id } = data
    let colletionOffer = BigInt(offerPrice)

    if (outbidOptions.outbid) {
      let highestBids = await fetchOpenseaOffers(address, "TRAIT", slug, contractAddress, JSON.parse(trait))
      highestBids = Number(highestBids)
      const outbidMargin = (outbidOptions.openseaOutbidMargin || 0.0001) * 1e18
      const bidPrice = !highestBids ? Number(offerPrice) : highestBids + outbidMargin
      colletionOffer = BigInt(bidPrice)
    }

    if (outbidOptions.outbid && maxBidPriceEth > 0 && Number(colletionOffer) / 1e18 > maxBidPriceEth) {
      console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(RED + `Offer price ${Number(colletionOffer) / 1e18} ETH for ${slug} ${trait} exceeds max bid price ${maxBidPriceEth} ETH FOR OPENSEA. Skipping ...`.toUpperCase() + RESET);
      console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
      return
    }

    const bidCount = await getIncrementedBidCount(OPENSEA, slug, _id)

    await bidOnOpensea(
      _id,
      bidCount,
      address,
      privateKey,
      slug,
      colletionOffer,
      creatorFees,
      enforceCreatorFee,
      expiry,
      trait
    );
    const redisKey = `opensea:${slug}:${trait}`;
    const offerKey = `${bidCount}:${redisKey}`
    await redis.setex(offerKey, expiry, offerPrice.toString());
  } catch (error) {
    console.error(RED + `Error processing OpenSea trait bid for task: ${data?.slug}` + RESET, error);
  }
}

async function processOpenseaTokenBid(data: {
  _id: string;
  address: string;
  privateKey: string;
  slug: string;
  offerPrice: string;
  creatorFees: IFee;
  enforceCreatorFee: boolean;
  asset: { contractAddress: string, tokenId: number },
  expiry: number,
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  }
  maxBidPriceEth: number;
}) {
  try {
    const { address, privateKey, slug, offerPrice, creatorFees, enforceCreatorFee, asset, expiry, outbidOptions, maxBidPriceEth, _id } = data
    let colletionOffer = BigInt(offerPrice)

    if (outbidOptions.outbid) {
      let highestBids = await fetchOpenseaOffers(address, "TOKEN", slug, asset.contractAddress, asset.tokenId.toString())
      highestBids = Number(highestBids)
      const outbidMargin = (outbidOptions.openseaOutbidMargin || 0.0001) * 1e18
      const bidPrice = !highestBids ? Number(offerPrice) : highestBids + outbidMargin
      colletionOffer = BigInt(bidPrice.toString())
    }

    if (outbidOptions.outbid && maxBidPriceEth > 0 && Number(colletionOffer) / 1e18 > maxBidPriceEth) {
      console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
      console.log(RED + `Offer price ${Number(colletionOffer) / 1e18} ETH for ${slug} ${asset.tokenId} exceeds max bid price ${maxBidPriceEth} ETH FOR OPENSEA. Skipping ...`.toUpperCase() + RESET);
      console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
      return
    }


    const bidCount = await getIncrementedBidCount(OPENSEA, slug, _id)
    await bidOnOpensea(
      _id,
      bidCount,
      address,
      privateKey,
      slug,
      colletionOffer,
      creatorFees,
      enforceCreatorFee,
      expiry,
      undefined,
      asset
    )
    const redisKey = `opensea:${slug}:${asset.tokenId}`;
    const offerKey = `${bidCount}:${redisKey}`
    await redis.setex(offerKey, expiry, colletionOffer.toString());

  } catch (error) {
    console.log(error);
  }
}

async function processBlurTraitBid(data: {
  _id: string;
  address: string;
  privateKey: string;
  contractAddress: string;
  offerPrice: string;
  slug: string;
  trait: string;
  expiry: number;
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  };
  maxBidPriceEth: number
}) {
  const { address, privateKey, contractAddress, offerPrice, slug, trait, expiry, outbidOptions, maxBidPriceEth, _id } = data;
  let collectionOffer = BigInt(Math.round(Number(offerPrice) / 1e16) * 1e16);

  try {
    if (outbidOptions.outbid) {
      const outbidMargin = outbidOptions.blurOutbidMargin || 0.01;
      const bids = await fetchBlurBid(slug, "TRAIT", JSON.parse(trait));
      const highestBids = bids?.priceLevels?.length ? bids.priceLevels.sort((a, b) => +b.price - +a.price)[0].price : 0;
      const bidPrice = Number(highestBids) + outbidMargin;
      collectionOffer = BigInt(Math.ceil(bidPrice * 1e18));
    }

    const offerPriceEth = Number(collectionOffer) / 1e18;
    if (outbidOptions.outbid && maxBidPriceEth > 0 && offerPriceEth > maxBidPriceEth) {
      console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
      console.log(RED + `Offer price ${offerPriceEth} ETH for ${slug} ${JSON.stringify(trait)} exceeds max bid price ${maxBidPriceEth} ETH. Skipping ...`.toUpperCase() + RESET);
      console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
      return;
    }

    const bidCount = await getIncrementedBidCount(BLUR, slug, _id)
    await bidOnBlur(_id, bidCount, address, privateKey, contractAddress, collectionOffer, slug, expiry, trait);
    const redisKey = `blur:${slug}:${trait}`;
    const offerKey = `${bidCount}:${redisKey}`
    await redis.setex(offerKey, expiry, collectionOffer.toString());
  } catch (error) {
    console.error(RED + `Error processing Blur trait bid for task: ${data?.slug}` + RESET, error);
  }
}

async function processMagicedenScheduledBid(task: ITask) {
  try {
    if (!task.running || !task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("magiceden")) return

    const filteredTasks = Object.fromEntries(
      Object.entries(task?.selectedTraits || {}).map(([category, traits]) => [
        category,
        traits.filter(trait => trait.availableInMarketplaces.includes("magiceden"))
      ]).filter(([_, traits]) => traits.length > 0)
    );

    const WALLET_ADDRESS: string = task.wallet.address
    const WALLET_PRIVATE_KEY: string = task.wallet.privateKey
    const selectedTraits = transformNewTask(filteredTasks)
    const traitBid = selectedTraits && Object.keys(selectedTraits).length > 0
    const contractAddress = task.contract.contractAddress
    const expiry = getExpiry(task.bidDuration)
    const duration = expiry / 60 || 15;
    const currentTime = new Date().getTime();
    const expiration = Math.floor((currentTime + (duration * 60 * 1000)) / 1000);
    const floor_price = await fetchMagicEdenCollectionStats(task.contract.contractAddress)
    const autoIds = task.tokenIds
      .filter(id => id.toString().toLowerCase().startsWith('bot'))
      .map(id => {
        const matches = id.toString().match(/\d+/);
        return matches ? parseInt(matches[0]) : null;
      })
      .filter(id => id !== null);

    const amount = autoIds[0]
    const bottlomListing = amount ? await fetchMagicEdenTokens(task.contract.contractAddress, amount) : []
    const taskTokenIds = task.tokenIds
    const tokenIds = bottlomListing ? [...bottlomListing, ...taskTokenIds] : [...taskTokenIds]
    const tokenBid = task.bidType === "token" && tokenIds.length > 0

    if (floor_price === 0) return

    console.log(MAGENTA + `Current magiceden floor price for ${task.contract.slug}: ${floor_price} ETH`.toUpperCase() + RESET);

    const magicedenOutbidMargin = task.outbidOptions.magicedenOutbidMargin || 0.0001

    const { offerPriceEth, maxBidPriceEth } = calculateBidPrice(task, floor_price as number, "magiceden")

    const approved = await approveMarketplace(WETH_CONTRACT_ADDRESS, MAGICEDEN_MARKETPLACE, task, maxBidPriceEth);

    if (!approved) return
    let offerPrice = Math.ceil(offerPriceEth * 1e18)

    if (tokenBid) {
      const jobs = tokenIds
        .filter(token => !isNaN(Number(token)))
        .map((token) => ({
          name: MAGICEDEN_TOKEN_BID,
          data: {
            _id: task._id,
            address: WALLET_ADDRESS,
            contractAddress,
            quantity: 1,
            offerPrice,
            expiration,
            privateKey: WALLET_PRIVATE_KEY,
            slug: task.contract.slug,
            tokenId: token,
            outbidOptions: task.outbidOptions,
            maxBidPriceEth
          },
          opts: { priority: TOKEN_BID_PRIORITY.MAGICEDEN }
        }));
      // await processBulkJobs(jobs);

      await processBulkJobs(jobs);
      console.log(`ADDED ${jobs.length} ${task.contract.slug} MAGICEDEN TOKEN BID JOBS TO QUEUE`);
    }
    else if (traitBid) {
      const traits = Object.entries(selectedTraits).flatMap(([key, values]) =>
        values.map(value => ({ attributeKey: key, attributeValue: value }))
      );
      const traitJobs = traits.map((trait) => ({
        name: MAGICEDEN_TRAIT_BID,
        data: {
          _id: task._id,
          address: WALLET_ADDRESS,
          contractAddress,
          quantity: 1,
          offerPrice,
          expiration,
          privateKey: WALLET_PRIVATE_KEY,
          slug: task.contract.slug,
          trait
        },
        opts: { priority: TRAIT_BID_PRIORITY.MAGICEDEN }
      }));
      // await processBulkJobs(traitJobs);

      await processBulkJobs(traitJobs);
      console.log(`ADDED ${traitJobs.length} ${task.contract.slug} MAGICEDEN TRAIT BID JOBS TO QUEUE`);
    }
    else if (task.bidType.toLowerCase() === "collection" && !traitBid) {
      if (task.outbidOptions.outbid) {
        const offer = await fetchMagicEdenOffer("COLLECTION", task.wallet.address, task.contract.contractAddress)
        if (offer && offer.amount) {
          const highestOffer = +offer.amount.raw;
          offerPrice = Math.ceil(highestOffer + (magicedenOutbidMargin * 1e18));
        } else {
          console.error(RED + `No valid offer received for collection: ${task.contract.slug}` + RESET);
        }
      }
      if (task.outbidOptions.outbid && maxBidPriceEth > 0 && Number(offerPrice) / 1e18 > maxBidPriceEth) {
        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `Offer price ${Number(offerPrice) / 1e18} ETH for ${task.contract.slug} exceeds max bid price ${maxBidPriceEth} ETH FOR MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        return
      }
      const bidCount = await getIncrementedBidCount(MAGICEDEN, task.contract.slug, task._id)
      await bidOnMagiceden(task._id, bidCount, WALLET_ADDRESS, contractAddress, 1, offerPrice.toString(), WALLET_PRIVATE_KEY, task.contract.slug);
    }
  } catch (error) {
    console.error(RED + `Error processing MagicEden scheduled bid for task: ${task._id}` + RESET, error);
  }
}

async function processMagicedenTokenBid(data: {
  _id: string;
  address: string;
  contractAddress: string;
  quantity: number;
  offerPrice: string;
  expiration: string;
  privateKey: string,
  slug: string;
  tokenId: string | number;
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  },
  maxBidPriceEth: number
}) {
  try {
    const
      {
        contractAddress,
        address,
        quantity,
        offerPrice,
        expiration,
        privateKey,
        slug,
        tokenId,
        outbidOptions,
        maxBidPriceEth,
        _id
      } = data


    const magicedenOutbidMargin = outbidOptions?.magicedenOutbidMargin || 0.0001
    let collectionOffer = Number(offerPrice)

    if (outbidOptions?.outbid) {
      const offer = await fetchMagicEdenOffer("TOKEN", address, contractAddress, tokenId.toString())
      if (offer && offer.amount) {
        const highestOffer = +offer.amount.raw
        collectionOffer = highestOffer + (magicedenOutbidMargin * 1e18)
      } else {
        console.error(RED + `No valid offer received for tokenId: ${tokenId}` + RESET);
      }
    }

    if (outbidOptions.outbid && maxBidPriceEth > 0 && Number(collectionOffer / 1e18) > maxBidPriceEth) {
      console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
      console.log(RED + `magiceden offer ${collectionOffer / 1e18} WETH for ${slug} ${tokenId}  exceeds max bid price ${maxBidPriceEth} WETH ON MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
      console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
      return;
    }

    const bidCount = await getIncrementedBidCount(MAGICEDEN, slug, _id)
    await bidOnMagiceden(_id, bidCount, address, contractAddress, quantity, collectionOffer.toString(), privateKey, slug, undefined, tokenId)
  } catch (error) {
    console.error(RED + `Error processing MagicEden token bid for task: ${data?.slug}` + RESET, error);
  }
}

async function processMagicedenTraitBid(data: {
  _id: string;
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
        address, quantity, offerPrice, expiration, privateKey, slug, trait, _id } = data

    const bidCount = await getIncrementedBidCount(MAGICEDEN, slug, _id)
    await bidOnMagiceden(_id, bidCount, address, contractAddress, quantity, offerPrice, privateKey, slug, trait)
  } catch (error) {
    console.error(RED + `Error processing MagicEden trait bid for task: ${data?.slug}` + RESET, error);
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
    const parsedOrderIds = orderIds.map(orderId => {
      try {
        const parsed = JSON.parse(orderId);
        return parsed.orderId || null;
      } catch {
        return orderId;
      }
    }).filter(id => id !== null);
    if (parsedOrderIds.length > 0) {
      await cancelMagicEdenBid(parsedOrderIds, privateKey)
    }
  } catch (error) {
    console.log(error);
  }
}

async function validateBidCount() {
  try {
    console.log('UPDATING TASKS BIDCOUNT');

    for (const task of currentTasks) {
      const keys = {
        counts: {
          opensea: `opensea:${task._id}:count`,
          blur: `blur:${task._id}:count`,
          magiceden: `magiceden:${task._id}:count`
        },
        patterns: {
          opensea: `*:${task._id}:opensea:order:${task.contract.slug}:*`,
          magiceden: `*:${task._id}:magiceden:order:${task.contract.slug}:*`,
          blur: `*:${task._id}:blur:order:${task.contract.slug}:*`
        }
      };

      const [openseaBids, magicedenBids, blurBids] = await Promise.all([
        redis.keys(keys.patterns.opensea),
        redis.keys(keys.patterns.magiceden),
        redis.keys(keys.patterns.blur)
      ]);

      await Promise.all([
        redis.set(keys.counts.opensea, openseaBids.length),
        redis.set(keys.counts.magiceden, magicedenBids.length),
        redis.set(keys.counts.blur, blurBids.length)
      ]);
    }
  } catch (error) {
    console.log(error);
  }
}

setInterval(validateBidCount, 60000);


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

function getExpiry(bidDuration: { value: number; unit: string }) {
  const expiry = bidDuration.unit === 'minutes'
    ? bidDuration.value * 60
    : bidDuration.unit === 'hours'
      ? bidDuration.value * 3600
      : bidDuration.unit === 'days'
        ? bidDuration.value * 86400
        : 900;

  return expiry
}

function calculateBidPrice(task: ITask, floorPrice: number, marketplaceName: "opensea" | "magiceden" | "blur"): { offerPriceEth: number; maxBidPriceEth: number } {
  const isGeneralBidPrice = task.bidPriceType === "GENERAL_BID_PRICE";

  const marketplaceBidPrice = marketplaceName.toLowerCase() === "blur" ? task.blurBidPrice
    : marketplaceName.toLowerCase() === "opensea" ? task.openseaBidPrice
      : marketplaceName.toLowerCase() === "magiceden" ? task.magicEdenBidPrice
        : task.bidPrice

  let bidPrice = isGeneralBidPrice ? task.bidPrice : marketplaceBidPrice;

  if (task.bidPriceType === "MARKETPLACE_BID_PRICE" && !marketplaceBidPrice) {
    if (!task.bidPrice) throw new Error("No bid price found");
    bidPrice = task.bidPrice;
  }

  let offerPriceEth: number;
  if (bidPrice.minType === "percentage") {
    offerPriceEth = Number((floorPrice * bidPrice.min / 100).toFixed(4));
    console.log(YELLOW + `Calculated offer price: ${offerPriceEth} ETH (${bidPrice.min}% of floor price)` + RESET);
  } else {
    offerPriceEth = bidPrice.min;
    console.log(YELLOW + `Using fixed offer price: ${offerPriceEth} ETH` + RESET);
  }

  let maxBidPriceEth: number;
  if (bidPrice.maxType === "percentage") {
    maxBidPriceEth = Number((floorPrice * (bidPrice.max || task.bidPrice.max) / 100).toFixed(4));
  } else {
    maxBidPriceEth = bidPrice.max || task.bidPrice.max;
  }

  return { offerPriceEth, maxBidPriceEth };
}

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

async function getIncrementedBidCount(marketplace: string, slug: string, taskId: string): Promise<string> {
  const countKey = `${marketplace}:${slug}:bidCount`;
  const count = await redis.incr(countKey);
  return `${count}:${taskId}`
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
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error(RED + `WebSocket is not open for subscribing to collections: ${task.contract.slug}` + RESET);
        return;
      }

      const connectToOpensea = task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("opensea");
      const connectToBlur = task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("blur");
      const connectToMagiceden = task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("magiceden");

      if (connectToOpensea && task.outbidOptions.counterbid && task.running) {
        const openseaSubscriptionMessage = {
          "slug": task.contract.slug,
          "event": "join_the_party",
          "topic": task.contract.slug,
          "contractAddress": task.contract.contractAddress,
          "clientId": task.user.toString(),
        };

        ws.send(JSON.stringify(openseaSubscriptionMessage));
        console.log('----------------------------------------------------------------------');
        console.log(`SUBSCRIBED TO COLLECTION: ${task.contract.slug} OPENSEA`);
        console.log('----------------------------------------------------------------------');

        setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                event: "ping",
                "clientId": task.user.toString(),
              })
            );
          }
        }, 30000);
      }

      if (connectToMagiceden && task.outbidOptions.counterbid && task.running) {
        const magicedenSubscriptionMessage = {
          "topic": task.contract.slug,
          "slug": task.contract.slug,
          "contractAddress": task.contract.contractAddress,
          "event": "join_the_party",
          "clientId": task.user.toString(),
          "payload": {},
          "ref": 0
        }

        ws.send(JSON.stringify(magicedenSubscriptionMessage));
        console.log('----------------------------------------------------------------------');
        console.log(`SUBSCRIBED TO COLLECTION: ${task.contract.slug} MAGICEDEN`);
        console.log('----------------------------------------------------------------------');

        setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                event: "ping",
                "clientId": task.user.toString(),
              })
            );
          }
        }, 30000);
      }

      if (connectToBlur && task.outbidOptions.counterbid && task.running) {
        const blurSubscriptionMessage = {
          "topic": task.contract.slug,
          "slug": task.contract.slug,
          "contractAddress": task.contract.contractAddress,
          "event": "join_the_party",
          "clientId": task.user.toString(),
          "payload": {},
          "ref": 0
        }

        ws.send(JSON.stringify(blurSubscriptionMessage));
        console.log('----------------------------------------------------------------------');
        console.log(`SUBSCRIBED TO COLLECTION: ${task.contract.slug} BLUR`);
        console.log('----------------------------------------------------------------------');
      }
    });
  } catch (error) {
    console.error(RED + 'Error subscribing to collections' + RESET, error);
  }
}

function checkOpenseaTrait(selectedTraits: any, trait_criteria: any) {
  if (selectedTraits.hasOwnProperty(trait_criteria.trait_type)) {
    return selectedTraits[trait_criteria.trait_type].includes(trait_criteria.trait_name);
  }
  return false;
}

function checkMagicEdenTrait(selectedTraits: Record<string, string[]>, trait: { attributeKey: string; attributeValue: string }) {
  if (selectedTraits.hasOwnProperty(trait.attributeKey)) {
    return selectedTraits[trait.attributeKey].includes(trait.attributeValue)
  }
  return false;
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

function checkBlurTraits(incomingBids: any, traits: any) {
  const traitKeys = traits.flatMap((trait: any) => Object.entries(trait).map(([key, value]) => ({ key, value })));
  return incomingBids.filter((bid: any) => {
    return traitKeys.some((trait: any) => {
      return bid.criteriaValue[trait.key] === trait.value;
    });
  });
}


async function approveMarketplace(currency: string, marketplace: string, task: ITask, maxBidPriceEth: number): Promise<boolean> {
  const lockKey = `approve:${task.wallet.address.toLowerCase()}:${marketplace.toLowerCase()}`;

  return await lockManager.withLock(lockKey, async () => {
    try {
      const provider = new ethers.providers.AlchemyProvider('mainnet', ALCHEMY_API_KEY);
      const signer = new Web3Wallet(task.wallet.privateKey, provider);
      const wethContract = new Contract(currency, WETH_MIN_ABI, signer);

      let allowance = Number(await wethContract.allowance(task.wallet.address, marketplace)) / 1e18;
      if (allowance > maxBidPriceEth) return true;

      if (!task?.wallet.openseaApproval) {
        console.log(`Approving WETH ${marketplace} as a spender for wallet ${task.wallet.address} with amount: ${constants.MaxUint256.toString()}...`.toUpperCase());
        const tx = await wethContract.approve(marketplace, constants.MaxUint256);
        await tx.wait();

        const updateData = marketplace.toLowerCase() === SEAPORT.toLowerCase()
          ? { openseaApproval: true }
          : { magicedenApproval: true };

        await Wallet.updateOne({ address: { $regex: new RegExp(task.wallet.address, 'i') } }, updateData);
        await Task.updateOne({ _id: task._id }, { $set: updateData });
      }

      return true;
    } catch (error: any) {
      const name = marketplace.toLowerCase() === "0x0000000000000068f116a894984e2db1123eb395".toLowerCase() ? OPENSEA : MAGICEDEN;

      if (error.code === 'INSUFFICIENT_FUNDS') {
        console.error(RED + `Error: Wallet ${task.wallet.address} could not approve ${name} as a spender. Please ensure your wallet has enough ETH to cover the gas fees and permissions are properly set.`.toUpperCase() + RESET);
      } else {
        console.error(RED + `Error: Wallet ${task.wallet.address} could not approve the ${name} as a spender. Task has been stopped.`.toUpperCase() + RESET);
      }
      return false;
    }
  }) ?? false;
}


interface SelectedTraits {
  [key: string]: {
    name: string;
    availableInMarketplaces: string[];
  }[];
}

export interface ITask {
  _id: string;
  user: string;
  contract: {
    slug: string;
    contractAddress: string;
  };
  wallet: {
    address: string;
    privateKey: string;
    openseaApproval: boolean;
    blurApproval: boolean;
    magicedenApproval: boolean
  };
  selectedMarketplaces: string[];
  running: boolean;
  tags: { name: string; color: string }[];
  selectedTraits: SelectedTraits;
  traits: {
    categories: Record<string, string>;
    counts: Record<
      string,
      Record<string, { count: number; availableInMarketplaces: string[] }>
    >;
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
    max: number;
    minType: "percentage" | "eth";
    maxType: "percentage" | "eth";
  };

  openseaBidPrice: {
    min: number;
    max: number;
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
    max: number;
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
  tokenIds: (number | string)[];
  bidType: string;
  loopInterval: { value: number; unit: string };
  bidPriceType: "GENERAL_BID_PRICE" | "MARKETPLACE_BID_PRICE";

}

interface BidLevel {
  contractAddress: string;
  updates: Update[];
}

interface Update {
  criteriaType: string;
  criteriaValue: Record<string, unknown>;
  price: string;
  executableSize: number;
  bidderCount: number;
  singleBidder: string | null;
}

interface BidStat {
  criteriaType: string;
  criteriaValue: { [key: string]: string };
  bestPrice: string;
  totalValue: string;
}

interface BidStats {
  contractAddress: string;
  stats: BidStat[];
}
interface CombinedBid extends BidStats, BidLevel { }


function transformNewTask(newTask: Record<string, Array<{ name: string }>>): Record<string, string[]> {
  const transformedTask: Record<string, string[]> = {};

  for (const key in newTask) {
    if (newTask.hasOwnProperty(key)) {
      transformedTask[key] = newTask[key].map(item => item.name);
    }
  }
  return transformedTask;
}

queueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(RED + `Job ${jobId} failed: ${failedReason}` + RESET);
});

queueEvents.on('stalled', ({ jobId }) => {
  console.warn(YELLOW + `Job ${jobId} stalled` + RESET);
});