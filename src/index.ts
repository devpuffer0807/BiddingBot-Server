import express from "express";
import { config } from "dotenv";
import bodyParser from "body-parser";
import { clearTimeout } from 'timers';
import os from "os"
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
import { Queue, Worker, QueueEvents, Job, QueueOptions, JobType } from "bullmq";
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
export const OPENSEA_TOKEN_BID_COUNTERBID = "OPENSEA_TOKEN_BID_COUNTERBID"
export const OPENSEA_COLLECTION_BID_COUNTERBID = "OPENSEA_COLLECTION_BID_COUNTERBID"

export const MAGICEDEN_TOKEN_BID_COUNTERBID = "MAGICEDEN_TOKEN_BID_COUNTERBID"
const MAGICEDEN_TRAIT_BID = "MAGICEDEN_TRAIT_BID"
const CANCEL_OPENSEA_BID = "CANCEL_OPENSEA_BID"
const CANCEL_MAGICEDEN_BID = "CANCEL_MAGICEDEN_BID"
const CANCEL_BLUR_BID = "CANCEL_BLUR_BID"
const MAGICEDEN_MARKETPLACE = "0x9A1D00bEd7CD04BCDA516d721A596eb22Aac6834"

const MAX_RETRIES: number = 5;
const RATE_LIMIT = Number(process.env.RATE_LIMIT)
const MARKETPLACE_WS_URL = "wss://wss-marketplace.nfttools.website";
const ALCHEMY_API_KEY = "HGWgCONolXMB2op5UjPH1YreDCwmSbvx"

const OPENSEA_PROTOCOL_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395"
const QUEUE_OPTIONS: QueueOptions = {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: true,
    attempts: 3
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

const taskIntervals = new Map<string, NodeJS.Timeout>();
const activeSubscriptions: Set<string> = new Set();


const walletsArr: string[] = []

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    try {
      const result = await processJob(job);
      return result;
    } catch (error) {
      console.error(RED + `Error processing job ${job.id}:`, error, RESET);
      throw error;
    }
  },
  {
    // settings: {},
    connection: redis,
    concurrency: RATE_LIMIT * 1.5,
    limiter: {
      max: RATE_LIMIT,
      duration: 1000
    },
    maxStalledCount: 0,
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

const MIN_BID_DURATION = 60
// Add near the top with other imports

// Add these functions
function cleanupMemory() {
  if (global.gc) {
    global.gc();
  }
}


// Modify the monitorHealth function
async function monitorHealth() {
  try {
    const counts = await queue.getJobCounts();
    const used = process.memoryUsage();
    const memoryStats = {
      rss: `${Math.round(used.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(used.external / 1024 / 1024)}MB`,
    }

    const totalMemory = os.totalmem();
    const memoryUsagePercent = (used.heapUsed / totalMemory) * 100;

    if (memoryUsagePercent > 75) {
      console.log(RED + `⚠️  HIGH MEMORY USAGE (${memoryUsagePercent.toFixed(2)}%) - INITIATING CLEANUP... ⚠️` + RESET);
      await queue.pause();
      cleanupMemory();

      setTimeout(async () => {
        await queue.resume();
        console.log(GREEN + '✨ Memory cleanup complete, resuming queue... ✨' + RESET);
      }, 5000);
    }


    // In the monitorHealth function
    if (await queue.isMaxed()) {
      await queue.pause();
    } else {
      // Resume the queue if it's not maxed
      await queue.resume();
    }


    // if (counts.active > RATE_LIMIT * 1.5) {
    //   console.log(YELLOW + '⏸️  PAUSING QUEUE TEMPORARILY DUE TO HIGH LOAD... ⏸️' + RESET);
    //   await queue.pause();
    //   setTimeout(async () => {
    //     await queue.resume();
    //     console.log(GREEN + '▶️  RESUMING QUEUE AFTER PAUSE... ▶️' + RESET);
    //   }, 2500);
    // } else {
    //   await queue.resume();
    // }

    const totalJobs = Object.values(counts).reduce((a, b) => a + b, 0);

    console.log('\n📊 ═══════ Health Monitor Stats ═══════ 📊');

    console.log(BLUE + '\n💾 Memory Usage:' + RESET);
    Object.entries(memoryStats).forEach(([key, value]) => {
      console.log(`   ${key}: ${value}`);
    });

    console.log(BLUE + '\n📋 Queue Status:' + RESET);
    Object.entries(counts).forEach(([key, value]) => {
      const color = value > RATE_LIMIT * 1.5 ? RED : value > 50 ? YELLOW : GREEN;
      console.log(`   ${key}: ${color}${value}${RESET}`);
    });
    console.log(`   Total Jobs: ${totalJobs}`);

    const isWorkerActive = worker.isRunning();
    console.log(BLUE + '\n👷 Worker Status:' + RESET, isWorkerActive ? GREEN + '✅ Running' + RESET : RED + '❌ Stopped' + RESET);

  } catch (error) {
    console.error(RED + '❌ Error monitoring health:' + RESET, error);
  }
}

// Increase the health check frequency
const HEALTH_CHECK_INTERVAL = 5000; // Check every 3 seconds instead of 5
setInterval(monitorHealth, HEALTH_CHECK_INTERVAL);

const PRIORITY_CHECK_INTERVAL = 1000; // Check every second
let priorityCheckInterval: NodeJS.Timeout;

async function cleanup() {
  console.log(YELLOW + '\n=== Starting Cleanup ===');

  if (priorityCheckInterval) {
    clearInterval(priorityCheckInterval);
  }

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
          ? [{ name: OPENSEA_SCHEDULE, data: task }]
          : []
      ).concat(
        formattedTasks.flatMap(task =>
          task.running && task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur")
            ? [{ name: BLUR_SCHEDULE, data: task }]
            : []
        )
      ).concat(
        formattedTasks.flatMap(task =>
          task.running && task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden")
            ? [{ name: MAGICEDEN_SCHEDULE, data: task }]
            : []
        )
      );

    console.log(`Created ${jobs.length} initial jobs`);
    // await processBulkJobs(jobs);

    console.log(GREEN + '=== Task Initialization Complete ===\n' + RESET);
  } catch (error) {
    console.error(RED + 'Error fetching current tasks:', error, RESET);
  }
}

const DOWNTIME_THRESHOLD = 5 * 60 * 1000;
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
        await queue.clean(0, 0, 'active');
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
    case OPENSEA_COLLECTION_BID_COUNTERBID:
      return await openseaCollectionCounterBid(job.data)
    case OPENSEA_TOKEN_BID_COUNTERBID:
      return await openseaTokenCounterBid(job.data);
    case MAGICEDEN_TOKEN_BID_COUNTERBID:
      return await magicedenTokenCounterBid(job.data);
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

const TASK_LOCK_DURATION = 1000; // 60 seconds in milliseconds

async function runScheduledLoop() {
  while (currentTasks.length > 0) {
    for (const task of currentTasks) {

      if (!task.running) continue
      const taskId = task?._id
      try {
        const hasJobs = await hasActivePrioritizedJobs(task)
        if (hasJobs) {
          continue;
        }

        if (isTaskLocked(taskId)) {
          continue;
        } else {
          const lockExists = taskLocks.has(taskId);
          if (lockExists) {

            taskLocks.delete(taskId);
            await startTask(task, true);
          } else {
            await startTask(task, true);
            continue;
          }
        }
      } catch (error) {
        console.error(RED + `Error processing scheduled task: ${taskId}` + RESET, error);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// Start the scheduled loop
(async function () {
  try {

    await fetchCurrentTasks()
    await runScheduledLoop();
  } catch (error) {
    console.error("Fatal error in scheduled loop:", error);
  }
})();

function setTaskLock(taskId: string, duration: number = TASK_LOCK_DURATION): void {
  taskLocks.set(taskId, {
    locked: true,
    lockUntil: Date.now() + duration + TASK_LOCK_DURATION
  });
}

function releaseTaskLock(taskId: string): void {
  taskLocks.delete(taskId);
}

function isTaskLocked(taskId: string): boolean {
  const lock = taskLocks.get(taskId);
  if (!lock) return false;

  const timeLeft = lock.lockUntil - Date.now();
  const lockDuration = lock.lockUntil - (Date.now() - timeLeft);

  console.log(`Lock status for task ${taskId}:`);
  console.log(`- Total lock duration: ${lockDuration}ms (${lockDuration / 1000}s)`);
  console.log(`- Time left: ${timeLeft}ms (${timeLeft / 1000}s)`);

  if (Date.now() > lock.lockUntil) {
    // Lock has expired, remove it
    taskLocks.delete(taskId);
    return false;
  }

  return lock.locked;
}

function getJobIds(marketplace: string, task: ITask) {
  const jobIds: string[] = []
  const selectedTraits = transformNewTask(task.selectedTraits)
  const isTraitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0

  const tokenBid = task.bidType === "token" && task.tokenIds.length > 0

  const traits = transformOpenseaTraits(selectedTraits);

  if (isTraitBid) {
    traits.map((trait) => {
      const uniqueKey = `${trait.type}-${trait.value}`
      jobIds.push(`${task._id}-${task.contract.slug}-${marketplace.toLowerCase()}-${uniqueKey}`)
    })
  } else if (tokenBid) {
    task.tokenIds.map((tokenId) => {
      jobIds.push(`${task._id}-${task.contract.slug}-${marketplace.toLowerCase()}-${tokenId}`)
    })
  } else {
    jobIds.push(`${task._id}-${task.contract.slug}-${marketplace.toLowerCase()}-collection`)
  }

  return jobIds
}

const DELAY_MS = 1000;
const MAX_CONCURRENT_BATCHES = 10

function createJobKey(job: Job) {
  let uniqueKey;
  let type, value, trait;
  switch (job.name) {
    case 'OPENSEA_TRAIT_BID':
      trait = JSON.parse(job.data.trait)
      type = trait.type
      value = trait.value
      uniqueKey = `opensea-${type}-${value}`
      break;
    case 'BLUR_TRAIT_BID':
      const traitObj = JSON.parse(job.data.trait);
      const traitKey = Object.keys(traitObj)[0];
      const traitValue = traitObj[traitKey];
      uniqueKey = `blur-${traitKey}-${traitValue}`;
      break;
    case 'MAGICEDEN_TRAIT_BID':
      type = job.data.trait.attributeKey
      value = job.data.trait.attributeValue
      uniqueKey = `magiceden-${type}-${value}`
      break;
    case 'OPENSEA_TOKEN_BID':
      uniqueKey = `opensea-${job.data.asset.tokenId}`
      break;
    case 'MAGICEDEN_TOKEN_BID':
      uniqueKey = `magiceden-${job.data.tokenId}`;
      break;
    default:
      uniqueKey = 'collection';
  }
  const baseKey = `${job?.data?._id}-${job?.data?.contract?.slug || job?.data?.slug}` || Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString()
  const key = `${baseKey}-${uniqueKey}`
  return key
}

async function processBulkJobs(jobs: any[], createKey = false) {
  if (!jobs || jobs.length === 0) {
    return;
  }

  // Filter out jobs for aborted tasks
  const filteredJobs = await Promise.all(jobs.map(async (job) => {
    const taskId = job.data._id?.toString();
    if (taskId && isTaskAborted(taskId)) {
      return null;
    }
    return job;
  }));

  const validJobs = filteredJobs.filter(job => job !== null);

  if (validJobs.length === 0) {
    return;
  }

  const batches = [];
  for (let i = 0; i < validJobs.length; i += RATE_LIMIT) {
    batches.push(validJobs.slice(i, i + RATE_LIMIT));
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
              ...(createKey && { jobId: createJobKey(job) }),
              ...job.opts,
              removeOnComplete: true,
              removeOnFail: true,
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
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea") ? [{ name: OPENSEA_SCHEDULE, data: task }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur") ? [{ name: BLUR_SCHEDULE, data: task }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden") ? [{ name: MAGICEDEN_SCHEDULE, data: task }] : []),
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

const taskLocks = new Map<string, { locked: boolean; lockUntil: number }>();

async function startTask(task: ITask, start: boolean) {
  const taskId = task._id.toString();
  try {
    await removeTaskFromAborted(taskId);
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
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea") ? [{ name: OPENSEA_SCHEDULE, data: { ...task, running: start } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur") ? [{ name: BLUR_SCHEDULE, data: { ...task, running: start } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden") ? [{ name: MAGICEDEN_SCHEDULE, data: { ...task, running: start } }] : []),
    ];
    await processBulkJobs(jobs);

    const lockDuration = getExpiry(task.loopInterval) * 1000
    setTaskLock(task._id, lockDuration)

  } catch (error) {
    console.error(RED + `Error starting task ${taskId}:` + RESET, error);
  } finally {
    taskLocks.delete(taskId);
  }
}


async function stopTask(task: ITask, start: boolean, marketplace?: string) {
  const taskId = task._id.toString();
  try {
    if (!marketplace || task.selectedMarketplaces.length === 0) {
      markTaskAsAborted(taskId);
      releaseTaskLock(taskId)
    }

    await queue.pause()
    await updateTaskStatus(task, start, marketplace);

    await cancelAllRelatedBids(task, marketplace)
    await removePendingAndWaitingBids(task, marketplace)
    await waitForRunningJobsToComplete(task, marketplace)

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

    if (marketplace) {
      await Promise.all([
        redis.del(`${marketplace.toLowerCase()}:${taskId}:count`),
      ]);


    } else {
      await Promise.all([
        redis.del(`magiceden:${taskId}:count`),
        redis.del(`blur:${taskId}:count`),
      ]);
    }


    await queue.resume()

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
    console.log(YELLOW + 'Queue paused while removing pending bids...'.toUpperCase() + RESET);
    let jobIds: string[] = []
    switch (marketplace?.toLowerCase()) {
      case OPENSEA.toLowerCase():
        jobIds = getJobIds(OPENSEA.toLowerCase(), task)
        break;
      case MAGICEDEN.toLowerCase():
        jobIds = getJobIds(MAGICEDEN.toLowerCase(), task)
        break;
      case BLUR.toLowerCase():
        jobIds = getJobIds(BLUR.toLowerCase(), task)
        break;
      default:
        jobIds = [
          ...getJobIds(BLUR.toLowerCase(), task),
          ...getJobIds(MAGICEDEN.toLowerCase(), task),
          ...getJobIds(OPENSEA.toLowerCase(), task)
        ]
    }

    const BATCH_SIZE = 5000;
    const CONCURRENT_BATCHES = 3;

    let totalJobsRemoved = 0;
    try {
      let start = 0;

      while (true) {
        const batchPromises = Array.from({ length: CONCURRENT_BATCHES }, async (_, i) => {
          const batchStart = start + (i * BATCH_SIZE);
          const jobs: Job[] = await queue.getJobs(['prioritized'], batchStart, batchStart + BATCH_SIZE - 1);

          if (jobs.length === 0) return null;
          Promise.all(jobs.map((job) => {
            if (!job.id) return
            if (jobIds.includes(job?.id)) {
              job.remove()
            }
          }))
          if (jobs.length > 0) return 0;
          return null;
        });

        const batchResults = await Promise.all(batchPromises);
        if (batchResults.every(result => result === null)) break;

        const batchTotal = batchResults.reduce((sum: number, count) =>
          sum + (count === null ? 0 : count), 0
        );
        totalJobsRemoved += batchTotal;

        start += (BATCH_SIZE * CONCURRENT_BATCHES);
      }
    } catch (error) {
      console.error(RED + `Error removing jobs in batch: ${error}` + RESET);
    }
    console.log('=== End Summary ====' + RESET);
    console.log(GREEN + 'Queue resumed after removing pending bids' + RESET);
  } catch (error) {
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

    console.log(YELLOW + 'Waiting for running jobs to complete...'.toUpperCase() + RESET);

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

    console.log(GREEN + 'All active bids completed...'.toUpperCase() + RESET);

  } catch (error: any) {
    console.error(RED + `Error waiting for running jobs to complete for task ${task.contract.slug}: ${error.message}` + RESET);
  }
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
  if (bids.length) { console.log(RED + `Found ${bids.length} OpenSea bids to cancel for ${slug}`.toUpperCase() + RESET) }

  const cancelData = bids.map(orderKey => ({
    name: CANCEL_OPENSEA_BID,
    data: { privateKey, orderKey },
    opts: { priority: CANCEL_PRIORITY.OPENSEA }
  }));

  await processBulkJobs(cancelData);
}


async function extractMagicedenOrderHash(orderKeys: string[]): Promise<string[]> {
  const bidData = await Promise.all(orderKeys.map(key => redis.get(key)));

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

  return extractedOrderIds as string[];
}

async function cancelMagicedenBids(orderKeys: string[], privateKey: string, slug: string, task: ITask) {
  if (!orderKeys.length) {
    return;
  }
  const taskId = task._id
  for (let i = 0; i < orderKeys.length; i += 1000) {
    const extractedOrderIds = await extractMagicedenOrderHash(orderKeys.slice(i, i + 1000))
    const batch = extractedOrderIds.slice(i, i + 1000);
    console.log(RED + `DELETING  batch ${Math.floor(i / 1000) + 1} of ${Math.ceil(extractedOrderIds.length / 1000)} (${batch.length} MAGICEDEN BIDS)`.toUpperCase() + RESET);
    await queue.add(CANCEL_MAGICEDEN_BID, { orderIds: batch, privateKey, orderKeys: orderKeys.slice(i, i + 1000) }, { priority: CANCEL_PRIORITY.MAGICEDEN });
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
  const cancelData = bids.map((orderKey) => {
    return {
      name: CANCEL_BLUR_BID,
      data: { privateKey, orderKey: orderKey },
      opts: { priority: CANCEL_PRIORITY.BLUR }
    }
  }).filter((item): item is { name: string; data: any; opts: { priority: 1 } } => item !== undefined);

  await processBulkJobs(cancelData);

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
          await queue.add(OPENSEA_SCHEDULE, task);
          break;
        case "magiceden":
          await queue.add(MAGICEDEN_SCHEDULE, task);
          break;
        case "blur":
          await queue.add(BLUR_SCHEDULE, task);
          break;
      }
    }

  } catch (error) {
    console.error(RED + `Error updating marketplace for task: ${task._id}` + RESET, error);
  }
}

async function handleOutgoingMarketplace(marketplace: string, task: ITask) {
  try {
    const countKey = `${marketplace}:${task._id}:count`;
    await redis.del(countKey);
    const taskId = task._id
    releaseTaskLock(taskId)

    await stopTask(task, false, marketplace);

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
  ws.addEventListener("open", async function open() {
    console.log(GOLD + "CONNECTED TO MARKETPLACE EVENTS WEBSCKET" + RESET);
    retryCount = 0;
    if (reconnectTimeoutId !== null) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
    if (heartbeatIntervalId !== null) {
      clearInterval(heartbeatIntervalId);
    }

    let clientId: string;

    if (currentTasks.length === 0) {
      await fetchCurrentTasks()
    }

    clientId = currentTasks[0].user.toString()

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
    attemptReconnect()
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
  try {
    const { contractAddress, slug } = getMarketplaceDetails(message);

    if (!contractAddress && !slug) {
      console.log("Missing contractAddress and slug in message");
      return;
    }

    const relevantTasks = currentTasks.filter(task =>
      task?.outbidOptions?.counterbid &&
      task?.running &&
      (task?.contract?.contractAddress?.toLowerCase() === contractAddress?.toLowerCase() ||
        task?.contract?.slug?.toLowerCase() === slug?.toLowerCase())
    );

    if (!relevantTasks.length) return;

    await Promise.all(relevantTasks.map(task => handleCounterBidForTask(task, message)));
  } catch (error) {
    console.error("Error in handleCounterBid:", error);
  }

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

    const wallets = await (await Wallet.find({}, { address: 1, _id: 0 }).exec()).map((wallet) => wallet.address.toLowerCase())
    const maker = data?.data?.maker?.toLowerCase()

    if (wallets.includes(maker)) {
      console.log(RED + "Skipping bid from known wallet address" + RESET);
      return
    }

    const expiry = getExpiry(task.bidDuration)
    const duration = expiry / 60 || 15;
    const currentTime = new Date().getTime();
    const expiration = Math.floor((currentTime + (duration * 60 * 1000)) / 1000);
    let floor_price: number = 0


    if (task.bidPrice.minType == "eth" || task.openseaBidPrice.minType === "eth") {
      floor_price = 0
    } else {
      floor_price = Number(await fetchMagicEdenCollectionStats(task.contract.contractAddress))
    }

    const { maxBidPriceEth } = calculateBidPrice(task, floor_price as number, "magiceden")
    const magicedenOutbidMargin = task.outbidOptions.magicedenOutbidMargin || 0.0001

    const bidType = data?.data?.criteria?.kind
    const tokenId = +data?.data?.criteria?.data?.token?.tokenId;

    let redisKey: string;
    let currentBidPrice: number | string;
    const incomingBidAmount: number = Number(data?.data?.price?.amount?.raw);
    let offerPrice: number;

    const selectedTraits = transformNewTask(task.selectedTraits)

    if (bidType === "token") {
      const currentTask = currentTasks.find((task) => task._id === task._id)
      if (!currentTask?.running || !currentTask.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes(MAGICEDEN.toLowerCase())) return

      console.log(MAGENTA + '----------------------------------------------------------------------------------' + RESET);
      console.log(MAGENTA + `incoming bid for ${task.contract.slug}:${tokenId} for ${incomingBidAmount / 1e18} WETH on magiceden`.toUpperCase() + RESET);
      console.log(MAGENTA + '----------------------------------------------------------------------------------' + RESET);

      const tokenIds = task.tokenIds.filter(id => !isNaN(Number(id)));

      const tokenBid = task.bidType === "token" && task.tokenIds.length > 0

      if (!tokenBid) return

      if (!tokenIds.includes(tokenId)) return

      const redisKeyPattern = `*:${task._id}:magiceden:${task.contract.slug}:${tokenId}`;
      const redisKeys = await redis.keys(redisKeyPattern)
      const currentOffers = await Promise.all(redisKeys.map((key) => redis.get(key)))
      const currentBidPrice = Math.max(...currentOffers.map((offer) => Number(offer)))


      if (incomingBidAmount < currentBidPrice) return

      offerPrice = Math.ceil((magicedenOutbidMargin * 1e18) + incomingBidAmount)
      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `magiceden counter offer ${offerPrice / 1e18} WETH for ${task.contract.slug} ${tokenId}  exceeds max bid price ${maxBidPriceEth} WETH ON MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }


      // MAGICEDEN_TOKEN_BID_COUNTERBID
      const bidData: IMagicedenTokenBidData = {
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
      }
      const jobId = `counterbid-${task._id}-${task.contract.slug}-${MAGICEDEN.toLowerCase()}-${tokenId}`
      const job: Job = await queue.getJob(jobId)

      if (job) {
        if (incomingBidAmount <= Number(job.data.offerPrice)) {
          console.log(RED + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
          console.log(RED + `Skipping counterbid since incoming bid ${incomingBidAmount / 1e18} WETH is less than or equal to existing bid ${Number(job.data.colletionOffer) / 1e18} WETH` + RESET);
          console.log(RED + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
          return
        } else {
          await job.updateData(bidData)
        }
      } else {
        await queue.add(
          MAGICEDEN_TOKEN_BID_COUNTERBID,
          bidData,
          {
            jobId,
          },

        );
      }


      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming magiceden offer of ${Number(incomingBidAmount) / 1e18} WETH for ${task.contract.slug} ${tokenId} for ${Number(offerPrice) / 1e18} WETH ON MAGICEDEN`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
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
      console.log(GREEN + `incoming bid for ${task.contract.slug}:trait ${JSON.stringify(trait)} for ${incomingBidAmount / 1e18} WETH on magiceden`.toUpperCase() + RESET);
      console.log(GREEN + '----------------------------------------------------------------------------------' + RESET);

      redisKey = `magiceden:${task.contract.slug}:${trait}`;
      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)

      if (incomingBidAmount < currentBidPrice) return

      offerPrice = Math.ceil((magicedenOutbidMargin * 1e18) + incomingBidAmount)
      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer ${offerPrice / 1e18} WETH for ${task.contract.slug} ${trait} exceeds max bid price ${maxBidPriceEth} WETH ON MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming offer of ${Number(incomingBidAmount) / 1e18} WETH for ${task.contract.slug} trait ${trait} for ${Number(offerPrice) / 1e18} WETH ON MAGICEDEN `.toUpperCase() + RESET);
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
      console.log(GREEN + `incoming collection offer for ${task.contract.slug} for ${incomingBidAmount / 1e18} WETH on magiceden`.toUpperCase() + RESET);
      console.log(GREEN + '----------------------------------------------------------------------------------' + RESET);

      redisKey = `magiceden:${task.contract.slug}:collection`;
      currentBidPrice = await redis.get(redisKey) || 0

      currentBidPrice = Number(currentBidPrice)
      if (incomingBidAmount < currentBidPrice) return
      offerPrice = Math.ceil((magicedenOutbidMargin * 1e18) + incomingBidAmount)

      if (maxBidPriceEth > 0 && Number(offerPrice) / 1e18 > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer ${offerPrice / 1e18} WETH for ${task.contract.slug}  exceeds max bid price ${maxBidPriceEth} WETH. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming magiceden offer of ${Number(incomingBidAmount) / 1e18} WETH for ${task.contract.slug} for ${Number(offerPrice) / 1e18} WETH`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);

      const bidCount = getIncrementedBidCount(MAGICEDEN, task.contract.slug, task._id)
      await bidOnMagiceden(task._id, bidCount, task.wallet.address, task.contract.contractAddress, 1, offerPrice.toString(), task.wallet.privateKey, task.contract.slug);
    }
  } catch (error) {
    console.error(RED + `Error handling MAGICEDEN counterbid: ${JSON.stringify(error)}` + RESET);
  }
}

async function handleOpenseaCounterbid(data: any, task: ITask) {
  try {
    const maker = data?.payload?.payload?.maker?.address.toLowerCase()
    const incomingBidAmount: number = Number(data?.payload?.payload?.base_price);
    const wallets = await (await Wallet.find({}, { address: 1, _id: 0 }).exec()).map((wallet) => wallet.address.toLowerCase())

    if (wallets.includes(maker)) {
      console.log(RED + "Skipping bid from known wallet address" + RESET);
      return
    }

    const expiry = getExpiry(task.bidDuration)
    let floor_price: number = 0

    if (task.bidPrice.minType == "eth" || task.openseaBidPrice.minType === "eth") {
      floor_price = 0
    } else {
      const stats = await getCollectionStats(task.contract.slug);
      floor_price = stats.total.floor_price;
    }

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
      const currentTask = currentTasks.find((task) => task._id === task._id)
      if (!currentTask?.running || !currentTask.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes(MAGICEDEN.toLowerCase())) return

      const tokenId = +data.payload.payload.protocol_data.parameters.consideration.find((item: any) => item.token.toLowerCase() === task.contract.contractAddress.toLowerCase()).identifierOrCriteria
      const tokenIds = task.tokenIds.filter(id => !isNaN(Number(id)));

      const tokenBid = task.bidType === "token" && task.tokenIds.length > 0

      if (!tokenBid) return

      if (!tokenIds.includes(tokenId)) return

      console.log(BLUE + '---------------------------------------------------------------------------------' + RESET);
      console.log(BLUE + `incoming offer for ${task.contract.slug}:${tokenId} for ${incomingBidAmount / 1e18} WETH on opensea`.toUpperCase() + RESET);
      console.log(BLUE + '---------------------------------------------------------------------------------' + RESET);

      const redisKeyPattern = `*:${task._id}:opensea:${task.contract.slug}:${tokenId}`;
      const redisKeys = await redis.keys(redisKeyPattern)
      const currentOffers = await Promise.all(redisKeys.map((key) => redis.get(key)))
      const currentBidPrice = Math.max(...currentOffers.map((offer) => Number(offer)))

      if (incomingBidAmount < currentBidPrice) return

      offerPrice = Math.ceil((openseaOutbidMargin * 1e18) + incomingBidAmount)

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


      const bidData: IProcessOpenseaTokenBidData = {
        _id: task._id,
        address: task.wallet.address,
        privateKey: task.wallet.privateKey,
        slug: task.contract.slug,
        offerPrice: Number(colletionOffer),
        creatorFees,
        enforceCreatorFee: collectionDetails.enforceCreatorFee,
        asset,
        expiry,
        outbidOptions: task.outbidOptions,
        maxBidPriceEth
      }


      const jobId = `counterbid-${task._id}-${task.contract.slug}-${OPENSEA.toLowerCase()}-${asset.tokenId}`
      const job: Job = await queue.getJob(jobId)

      if (job) {
        if (incomingBidAmount <= job.data.offerPrice) {
          console.log(RED + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
          console.log(RED + `Skipping counterbid since incoming bid ${incomingBidAmount / 1e18} WETH is less than or equal to existing bid ${Number(job.data.offerPrice) / 1e18} WETH` + RESET);
          console.log(RED + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
          return
        } else {
          await job.updateData(bidData)
        }
      } else {
        await queue.add(
          OPENSEA_TOKEN_BID_COUNTERBID,
          bidData,
          {
            jobId,
          },

        );
      }

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming opensea offer of ${Number(incomingBidAmount) / 1e18} WETH for ${task.contract.slug}:${asset.tokenId} for ${Number(colletionOffer) / 1e18} WETH ON OPENSEA`.toUpperCase() + RESET);
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

      console.log(BLUE + '---------------------------------------------------------------------------------' + RESET);
      console.log(BLUE + `incoming offer for ${task.contract.slug}:${trait} for ${incomingBidAmount / 1e18} WETH on opensea`.toUpperCase() + RESET);
      console.log(BLUE + '---------------------------------------------------------------------------------' + RESET);

      redisKey = `opensea:${task.contract.slug}:${trait}`;
      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)

      if (incomingBidAmount < currentBidPrice) return

      offerPrice = Math.ceil((openseaOutbidMargin * 1e18) + incomingBidAmount)

      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer ${offerPrice / 1e18} WETH for ${task.contract.slug} ${trait}  exceeds max bid price ${maxBidPriceEth} WETH ON OPENSEA. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }
      colletionOffer = BigInt(offerPrice)


      const jobId = `counterbid${"opensea"}${task.contract.slug}${trait}`
      const job: Job = await queue.getJob(jobId)
      const bidCount = getIncrementedBidCount(OPENSEA, task.contract.slug, task._id)

      const counterbidData: OpenseaCounterBidJobData = {
        _id: task._id,
        bidCount,
        address: task.wallet.address,
        privateKey: task.wallet.privateKey,
        slug: task.contract.slug,
        colletionOffer: Number(colletionOffer),
        creatorFees,
        enforceCreatorFee: collectionDetails.enforceCreatorFee,
        expiry,
        trait
      }


      if (job) {
        if (incomingBidAmount <= job.data.colletionOffer) {

          console.log(RED + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
          console.log(RED + `Skipping counterbid since incoming bid ${incomingBidAmount / 1e18} WETH is less than or equal to existing bid ${Number(job.data.colletionOffer) / 1e18} WETH` + RESET);
          console.log(RED + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
          return
        } else {
          await job.updateData(data)
        }
      } else {
        await queue.add(
          OPENSEA_TOKEN_BID_COUNTERBID,
          counterbidData,
          {
            jobId,
          },
        );
      }

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
      console.log(GREEN + `Counterbidding incoming opensea offer of ${Number(incomingBidAmount) / 1e18} WETH for ${task.contract.slug} ${trait} for ${Number(colletionOffer) / 1e18} WETH ON OPENSEA`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, offerPrice.toString());
    }
    if (data.event === "collection_offer") {

      console.log(JSON.stringify(data));

      const isTraitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0
      const tokenBid = task.bidType === "token" && task.tokenIds.length > 0
      const collectionBid = !isTraitBid && !tokenBid

      if (!collectionBid) return

      console.log(GOLD + '---------------------------------------------------------------------------------' + RESET);
      console.log(GOLD + `incoming collection offer for ${task.contract.slug} for ${incomingBidAmount / 1e18} WETH on opensea`.toUpperCase() + RESET);
      console.log(GOLD + '---------------------------------------------------------------------------------' + RESET);

      redisKey = `opensea:${task.contract.slug}:collection`;
      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)

      if (incomingBidAmount < currentBidPrice) return
      offerPrice = Math.ceil((openseaOutbidMargin * 1e18) + incomingBidAmount)

      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer price ${offerPrice / 1e18} WETH for ${task.contract.slug} exceeds max bid price ${maxBidPriceEth} WETH ON OPENSEA. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }
      colletionOffer = BigInt(offerPrice)
      const bidCount = getIncrementedBidCount(OPENSEA, task.contract.slug, task._id)


      const bidData: IOpenseaBidParams = {
        taskId: task._id,
        bidCount,
        walletAddress: task.wallet.address,
        walletPrivateKey: task.wallet.privateKey,
        slug: task.contract.slug,
        offerPrice: Number(colletionOffer),
        creatorFees,
        enforceCreatorFee: collectionDetails.enforceCreatorFee,
        expiry
      }

      const jobId = `counterbid-${task._id}-${task.contract.slug}-${OPENSEA.toLowerCase()}-collection`
      const job: Job = await queue.getJob(jobId)

      if (job) {
        if (incomingBidAmount <= job.data.offerPrice) {
          console.log(RED + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
          console.log(RED + `Skipping counterbid since incoming bid ${incomingBidAmount / 1e18} WETH is less than or equal to existing bid ${Number(job.data.offerPrice) / 1e18} WETH` + RESET);
          console.log(RED + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
          return
        } else {
          await job.updateData(bidData)
        }
      } else {
        await queue.add(
          OPENSEA_COLLECTION_BID_COUNTERBID,
          bidData,
          {
            jobId,
          },

        );
      }

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming offer of ${Number(incomingBidAmount) / 1e18} WETH for ${task.contract.slug} for ${Number(colletionOffer) / 1e18} WETH ON OPENSEA`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
    }
  } catch (error) {
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

      const bidCount = getIncrementedBidCount(BLUR, task.contract.slug, task._id)
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

// At the top of the file, add this global variable

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

      await processBulkJobs(jobs, true);

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

      if (task.running) await processBulkJobs(traitJobs, true);

      console.log(`ADDED ${traitJobs.length} ${task.contract.slug} OPENSEA TRAIT BID JOBS TO QUEUE`);
    } else if (task.bidType.toLowerCase() === "collection" && !traitBid) {
      const taskId = task._id
      const currentTask = currentTasks.find((task) => task._id === taskId)

      if (!currentTask?.running || !currentTask.selectedMarketplaces.map((market) => market.toLowerCase()).includes("opensea")) {
        console.log(RED + '⚠️ Task is no longer active or OpenSea not selected, skipping...' + RESET);
        return;
      }

      let colletionOffer = BigInt(offerPrice)
      const redisKey = `opensea:${task.contract.slug}:collection`
      const currentOfferKeyPattern = `*:${task._id}:opensea:order:${task.contract.slug}:default`

      const marketDataPromise = task.outbidOptions.outbid ?
        fetchOpenseaOffers(
          "COLLECTION",
          task.contract.slug,
          task.contract.contractAddress,
          {}
        ) :
        null;


      const [orderKey, ...remainingOffers] = await redis.keys(currentOfferKeyPattern)

      const [ttl, offer] = await Promise.all([
        redis.ttl(orderKey),
        redis.get(orderKey)
      ]);

      if (remainingOffers.length > 0) {
        console.log(YELLOW + `⏰ Found ${remainingOffers.length} stale offers, cleaning up...` + RESET);

        const cancelData = remainingOffers.map(orderKey => ({
          name: CANCEL_OPENSEA_BID,
          data: { privateKey: task.wallet.privateKey, orderKey },
          opts: { priority: CANCEL_PRIORITY.OPENSEA }
        }));
        await processBulkJobs(cancelData);
      }

      if (!task.outbidOptions.outbid) {
        if (ttl >= MIN_BID_DURATION) {
          const expiryTime = new Date(Date.now() + (ttl * 1000)); // Convert seconds to milliseconds
          console.log(BLUE + `Current bid for ${task.contract.slug} will expire at ${expiryTime.toISOString()} (in ${ttl} seconds), skipping...`.toUpperCase() + RESET);

          return;
        }

        if (offer) {
          await queue.add(CANCEL_OPENSEA_BID, { privateKey: task.wallet.privateKey, orderKey }, { priority: CANCEL_PRIORITY.OPENSEA })
        }
      }
      else {
        const highestBid = await marketDataPromise;

        const highestBidAmount = typeof highestBid === 'object' && highestBid ? Number(highestBid.amount) : Number(highestBid);
        const owner = highestBid && typeof highestBid === 'object' ? highestBid.owner?.toLowerCase() : '';
        const isOwnBid = walletsArr
          .map(addr => addr.toLowerCase())
          .includes(owner);

        // CASE 1 - no top offer
        if (isOwnBid) {
          if (ttl > MIN_BID_DURATION) {
            return
          } else {
            if (offer) {
              await queue.add(
                CANCEL_OPENSEA_BID,
                {
                  privateKey: task.wallet.privateKey,
                  orderKey
                },
                { priority: CANCEL_PRIORITY.OPENSEA }
              )
            }
          }
        }
        if (!isOwnBid && owner) {
          if (offer) {
            await queue.add(
              CANCEL_OPENSEA_BID,
              {
                privateKey: task.wallet.privateKey,
                orderKey
              },
              { priority: CANCEL_PRIORITY.OPENSEA }
            )
          }

          if (highestBidAmount) {
            const outbidMargin = (task.outbidOptions.openseaOutbidMargin || 0.0001) * 1e18
            colletionOffer = BigInt(highestBidAmount + outbidMargin)

            const offerPriceEth = Number(colletionOffer) / 1e18;
            if (maxBidPriceEth > 0 && offerPriceEth > maxBidPriceEth) {
              console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
              console.log(RED + `❌ Offer price ${offerPriceEth} ETH for ${task.contract.slug} collection bid exceeds max bid price ${maxBidPriceEth} ETH FOR OPENSEA. Skipping ...`.toUpperCase() + RESET);
              console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
              return;
            }
          }
        }
      }
      const bidCount = getIncrementedBidCount(OPENSEA, task.contract.slug, task._id)
      await Promise.all([
        bidOnOpensea(
          task._id,
          bidCount,
          WALLET_ADDRESS,
          WALLET_PRIVATE_KEY,
          task.contract.slug,
          offerPrice,
          creatorFees,
          collectionDetails.enforceCreatorFee,
          expiry
        ),
        redis.setex(`${bidCount}:${redisKey}`, expiry, offerPrice.toString())
      ]);

      console.log(GREEN + `✅ Successfully placed bid of ${Number(offerPrice) / 1e18} ETH for ${task.contract.slug}` + RESET);
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

      if (task.running) await processBulkJobs(traitJobs, true);

      console.log(`ADDED ${traitJobs.length} ${task.contract.slug} BLUR TRAIT BID JOBS TO QUEUE`);
    } else if (task.bidType.toLowerCase() === "collection" && !traitBid) {

      const taskId = task._id
      const currentTask = currentTasks.find((task) => task._id === taskId)

      if (!currentTask?.running || !currentTask.selectedMarketplaces.map((market) => market.toLowerCase()).includes("blur")) {
        console.log(RED + '⚠️ Task is no longer active or blur not selected, skipping...' + RESET);
        return;
      }

      let colletionOffer = BigInt(offerPrice)
      const currentOfferKeyPattern = `*:${task._id}:blur:order:${task.contract.slug}:default`

      const marketDataPromise = task.outbidOptions.outbid ?
        fetchBlurBid(task.contract.slug, "COLLECTION", {}) :
        null;

      const [orderKey, ...remainingOffers] = await redis.keys(currentOfferKeyPattern)


      const [ttl, offer] = await Promise.all([
        redis.ttl(orderKey),
        redis.get(orderKey)
      ]);

      if (remainingOffers.length > 0) {
        console.log(YELLOW + `⏰ Found ${remainingOffers.length} stale offers, cleaning up...` + RESET);

        const cancelData = remainingOffers.map((orderKey) => {
          return {
            name: CANCEL_BLUR_BID,
            data: { privateKey: task.wallet.privateKey, orderKey: orderKey },
            opts: { priority: CANCEL_PRIORITY.BLUR }
          }
        })

        await processBulkJobs(cancelData);
      }

      if (!task.outbidOptions.outbid) {
        if (ttl >= MIN_BID_DURATION) {
          const expiryTime = new Date(Date.now() + (ttl * 1000)); // Convert seconds to milliseconds
          console.log(BLUE + `Current bid for ${task.contract.slug} will expire at ${expiryTime.toISOString()} (in ${ttl} seconds), skipping...`.toUpperCase() + RESET);

          return;
        }
        if (offer) {
          await queue.add(CANCEL_BLUR_BID, { privateKey: task.wallet.privateKey, orderKey }, { priority: CANCEL_PRIORITY.BLUR })
        }
      }
      else {
        const highestBid = await marketDataPromise;

        const highestBidAmount = Number(highestBid?.priceLevels[0].price) * 1e18

        const redisKeyPattern = `*:${task._id}:blur:${task.contract.slug}:collection`;
        const redisKeys = await redis.keys(redisKeyPattern)
        const currentOffers = await Promise.all(redisKeys.map((key) => redis.get(key)))
        const currentBidPrice = Math.max(...currentOffers.map((offer) => Number(offer)))

        if (highestBidAmount > currentBidPrice) {
          if (offer) {
            await queue.add(
              CANCEL_BLUR_BID,
              {
                privateKey: task.wallet.privateKey,
                orderKey
              },
              { priority: CANCEL_PRIORITY.OPENSEA }
            )
          }

          if (highestBidAmount) {
            const outbidMargin = (task.outbidOptions.openseaOutbidMargin || 0.0001) * 1e18
            colletionOffer = BigInt(highestBidAmount + outbidMargin)

            const offerPriceEth = Number(colletionOffer) / 1e18;
            if (maxBidPriceEth > 0 && offerPriceEth > maxBidPriceEth) {
              console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
              console.log(RED + `❌ Offer price ${offerPriceEth} ETH for ${task.contract.slug} collection bid exceeds max bid price ${maxBidPriceEth} ETH FOR OPENSEA. Skipping ...`.toUpperCase() + RESET);
              console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
              return;
            }
          }
        }
      }

      const bidCount = getIncrementedBidCount(BLUR, task.contract.slug, task._id)
      await bidOnBlur(task._id, bidCount, WALLET_ADDRESS, WALLET_PRIVATE_KEY, contractAddress, colletionOffer, task.contract.slug, expiry);
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

    console.log({ currentTasks });

    // Validate task is still active and OpenSea marketplace is selected
    const currentTask = currentTasks.find((task) => task._id === _id)
    if (!currentTask?.running || !currentTask.selectedMarketplaces.map((market) => market.toLowerCase()).includes("opensea")) {
      console.log(RED + '⚠️ Task is no longer active or OpenSea not selected, skipping...' + RESET);
      return;
    }

    // Initialize bid amount and parse trait data
    let colletionOffer = BigInt(offerPrice)
    const { type, value } = JSON.parse(trait);

    // Set up Redis keys for tracking offers
    const redisKey = `opensea:${slug}:${trait}`;
    const currentOfferKeyPattern = `*:${_id}:opensea:order:${slug}:trait:${type}:${value}`

    // Start fetching market data early if outbid is enabled
    const marketDataPromise = outbidOptions.outbid ?
      fetchOpenseaOffers('TRAIT', slug, contractAddress, JSON.parse(trait)) :
      null;

    // Fetch all existing offers from Redis in parallel
    const [orderKey, ...remainingOffers] = await redis.keys(currentOfferKeyPattern)
    const [ttl, offer] = await Promise.all([
      redis.ttl(orderKey),
      redis.get(orderKey)
    ]);

    const cancelData = remainingOffers.map(orderKey => ({
      name: CANCEL_OPENSEA_BID,
      data: { privateKey, orderKey },
      opts: { priority: CANCEL_PRIORITY.OPENSEA }
    }));

    await processBulkJobs(cancelData);

    // Handle non-outbid scenario
    if (!outbidOptions.outbid) {
      if (ttl >= MIN_BID_DURATION) {
        console.log(GREEN + '✅ Current bid still valid, no action needed' + RESET);
        return;
      }

      // Cancel expired offers
      if (offer) {
        console.log(YELLOW + '⏰ Bid expired, cancelling...' + RESET);
        await queue.add(CANCEL_OPENSEA_BID, {
          privateKey,
          orderKey
        }, { priority: CANCEL_PRIORITY.OPENSEA })
      }
    }
    // Handle outbid scenario
    else {
      const highestBid = await marketDataPromise;

      // Verify if highest bid belongs to us
      const highestBidAmount = typeof highestBid === 'object' && highestBid ? Number(highestBid.amount) : Number(highestBid);
      const owner = highestBid && typeof highestBid === 'object' ? highestBid.owner?.toLowerCase() : '';
      const isOwnBid = walletsArr
        .map(addr => addr.toLowerCase())
        .includes(owner);

      if (!highestBidAmount || !owner) {
        if (offer) {

          await queue.add(
            CANCEL_OPENSEA_BID,
            {
              privateKey: privateKey,
              orderKey
            },
            { priority: CANCEL_PRIORITY.OPENSEA }
          )

        }
      } else if (!isOwnBid) {
        if (offer) {
          await queue.add(
            CANCEL_OPENSEA_BID,
            {
              privateKey,
              orderKey
            },
            { priority: CANCEL_PRIORITY.OPENSEA }
          )
        }

        if (highestBidAmount) {
          // Calculate new competitive bid
          const outbidMargin = (outbidOptions.openseaOutbidMargin || 0.0001) * 1e18
          colletionOffer = BigInt(highestBidAmount + outbidMargin)
          // Validate against max bid limit
          const offerPriceEth = Number(colletionOffer) / 1e18;
          if (maxBidPriceEth > 0 && offerPriceEth > maxBidPriceEth) {
            console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
            console.log(RED + `❌ Offer price ${offerPriceEth} ETH for ${slug} ${trait} exceeds max bid price ${maxBidPriceEth} ETH FOR OPENSEA. Skipping ...`.toUpperCase() + RESET);
            console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
            return
          }
        }
      } else {
        return;
      }
    }

    // Execute all cleanup operations in parallel
    // Get bid count and prepare for new bid
    const bidCount = getIncrementedBidCount(OPENSEA, slug, _id)

    // Place bid and update redis in parallel
    await Promise.all([
      bidOnOpensea(
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
      ),
      redis.setex(`${bidCount}:${redisKey}`, expiry, offerPrice.toString())
    ]);

  } catch (error) {
    console.error(RED + `❌ Error processing OpenSea trait bid for task: ${data?.slug}` + RESET, error);
  }
}

async function processOpenseaTokenBid(data: IProcessOpenseaTokenBidData) {
  try {
    const { address, privateKey, slug, offerPrice, creatorFees, enforceCreatorFee, asset, expiry, outbidOptions, maxBidPriceEth, _id } = data
    const currentTask = currentTasks.find((task) => task._id === _id)

    if (!currentTask?.running || !currentTask.selectedMarketplaces.map((market) => market.toLowerCase()).includes("opensea")) {
      console.log(RED + '⚠️ Task is no longer active or OpenSea not selected, skipping...' + RESET);
      return;
    }

    let colletionOffer = BigInt(offerPrice)

    const redisKey = `opensea:${slug}:${asset.tokenId}`;
    const currentOfferKeyPattern = `*:${_id}:opensea:order:${slug}:${asset.tokenId}`

    // Start fetching market data early if outbid is enabled
    const marketDataPromise = outbidOptions.outbid ?
      fetchOpenseaOffers("TOKEN", slug, asset.contractAddress, asset.tokenId.toString()) :
      null;

    // Fetch all existing offers from Redis in parallel
    const [orderKey, ...remainingOffers] = await redis.keys(currentOfferKeyPattern)
    const [ttl, offer] = await Promise.all([
      redis.ttl(orderKey),
      redis.get(orderKey)
    ]);

    const cancelData = remainingOffers.map(orderKey => ({
      name: CANCEL_OPENSEA_BID,
      data: { privateKey, orderKey },
      opts: { priority: CANCEL_PRIORITY.OPENSEA }
    }));

    await processBulkJobs(cancelData);

    if (!outbidOptions.outbid) {
      if (ttl >= MIN_BID_DURATION) {
        const expiryTime = new Date(Date.now() + (ttl * 1000)); // Convert seconds to milliseconds
        console.log(BLUE + `Current bid for ${slug}: ${asset.tokenId} will expire at ${expiryTime.toISOString()} (in ${ttl} seconds), skipping...`.toUpperCase() + RESET);

        return;
      }

      if (offer) {
        await queue.add(CANCEL_OPENSEA_BID, { privateKey, orderKey }, { priority: CANCEL_PRIORITY.OPENSEA })
      }
    } else {
      const highestBid = await marketDataPromise;

      const highestBidAmount = typeof highestBid === 'object' && highestBid ? Number(highestBid.amount) : Number(highestBid);
      const owner = highestBid && typeof highestBid === 'object' ? highestBid.owner?.toLowerCase() : '';
      const isOwnBid = walletsArr
        .map(addr => addr.toLowerCase())
        .includes(owner);

      // CASE 1 - no top offer
      if (isOwnBid) {
        if (ttl > MIN_BID_DURATION) {
          return
        } else {
          if (offer) {
            await queue.add(
              CANCEL_OPENSEA_BID,
              {
                privateKey,
                orderKey
              },
              { priority: CANCEL_PRIORITY.OPENSEA }
            )
          }
        }
      }
      if (!isOwnBid && owner) {
        if (offer) {
          await queue.add(
            CANCEL_OPENSEA_BID,
            {
              privateKey,
              orderKey
            },
            { priority: CANCEL_PRIORITY.OPENSEA }
          )
        }

        if (highestBidAmount) {
          const outbidMargin = (outbidOptions.openseaOutbidMargin || 0.0001) * 1e18
          colletionOffer = BigInt(highestBidAmount + outbidMargin)

          const offerPriceEth = Number(colletionOffer) / 1e18;
          if (maxBidPriceEth > 0 && offerPriceEth > maxBidPriceEth) {
            console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
            console.log(RED + `❌ Offer price ${offerPriceEth} ETH for ${slug} token ${asset.tokenId} exceeds max bid price ${maxBidPriceEth} ETH FOR OPENSEA. Skipping ...`.toUpperCase() + RESET);
            console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
            return;
          }
        }
      }
    }

    const bidCount = getIncrementedBidCount(OPENSEA, slug, _id)
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
    await redis.setex(`${bidCount}:${redisKey}`, expiry, colletionOffer.toString())

  } catch (error) {
    console.error(RED + `❌ Error processing OpenSea token bid for task: ${data?.slug}` + RESET, error);
  }
}

async function openseaCollectionCounterBid(data: IOpenseaBidParams) {
  const { taskId, bidCount, walletAddress, walletPrivateKey, slug, offerPrice, creatorFees, enforceCreatorFee, expiry } = data

  const currentTask = currentTasks.find((task) => task._id === taskId)
  if (!currentTask?.running || !currentTask.selectedMarketplaces.map((market) => market.toLowerCase()).includes("opensea")) {
    return
  }
  try {
    await bidOnOpensea(
      taskId,
      bidCount,
      walletAddress,
      walletPrivateKey,
      slug,
      BigInt(offerPrice),
      creatorFees,
      enforceCreatorFee,
      expiry,
    )

    const redisKey = `opensea:${slug}:collection`;
    const offerKey = `${bidCount}:${redisKey}`
    await redis.setex(offerKey, expiry, offerPrice.toString());
  } catch (error) {
    console.error(RED + `❌ Error processing OpenSea collection counter bid for task: ${slug}` + RESET, error);
  }
}

async function openseaTokenCounterBid(data: IProcessOpenseaTokenBidData) {
  const {
    _id,
    address,
    privateKey,
    slug,
    offerPrice,
    creatorFees,
    enforceCreatorFee,
    expiry,
    asset,

  } = data

  const currentTask = currentTasks.find((task) => task._id === _id)
  if (!currentTask?.running || !currentTask.selectedMarketplaces.map((market) => market.toLowerCase()).includes("opensea")) {

    return
  }

  const bidCount = getIncrementedBidCount(OPENSEA, slug, _id)
  try {
    const orderKeyPattern = `*:${_id}:opensea:order:${slug}:${asset?.tokenId}`
    const orderKeys = await redis.keys(orderKeyPattern)

    const cancelData = orderKeys.map(orderKey => ({
      name: CANCEL_OPENSEA_BID,
      data: { privateKey, orderKey },
      opts: { priority: CANCEL_PRIORITY.OPENSEA }
    }));

    await processBulkJobs(cancelData);

    await bidOnOpensea(
      _id,
      bidCount,
      address,
      privateKey,
      slug,
      BigInt(offerPrice),
      creatorFees,
      enforceCreatorFee,
      expiry,
      undefined,
      asset
    )

    const redisKey = `opensea:${slug}:${asset?.tokenId}`;
    const offerKey = `${bidCount}:${redisKey}`
    await redis.setex(offerKey, expiry, offerPrice.toString());
  } catch (error) {
    console.log(error);
  }
}

async function magicedenTokenCounterBid(data: IMagicedenTokenBidData) {
  try {
    const { _id, address, contractAddress, quantity, offerPrice, privateKey, slug, tokenId } = data

    // Validate task is running and marketplace is enabled
    const currentTask = currentTasks.find((task) => task._id === _id)
    if (!currentTask?.running || !currentTask.selectedMarketplaces.map((market) =>
      market.toLowerCase()).includes("magiceden")) {
      return
    }

    // Cancel existing bids
    const currentOfferKeyPattern = `*:${_id}:magiceden:order:${slug}:${tokenId}`
    const orderKeys = await redis.keys(currentOfferKeyPattern)
    const extractedOrderIds = await extractMagicedenOrderHash(orderKeys)

    if (orderKeys.length > 0) {
      await queue.add(CANCEL_MAGICEDEN_BID, {
        orderIds: extractedOrderIds,
        privateKey,
        orderKeys
      }, {
        priority: CANCEL_PRIORITY.MAGICEDEN
      });
    }

    // Place new bid
    const bidCount = getIncrementedBidCount(MAGICEDEN, slug, _id)

    await bidOnMagiceden(
      _id,
      bidCount,
      address,
      contractAddress,
      quantity,
      offerPrice.toString(),
      privateKey,
      slug,
      undefined,
      tokenId
    )
  } catch (error) {
    console.error('Error in magicedenTokenCounterBid:', error);
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
      console.log(RED + `Offer price ${offerPriceEth} ETH for ${slug} trait ${trait} exceeds max bid price ${maxBidPriceEth} ETH. Skipping ...`.toUpperCase() + RESET);
      console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
      return;
    }

    const bidCount = getIncrementedBidCount(BLUR, slug, _id)

    const currentTask = currentTasks.find((task) => task._id === _id)
    if (!currentTask?.running || !currentTask.selectedMarketplaces.map((market) => market.toLowerCase()).includes("blur")) return

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

      await processBulkJobs(jobs, true);

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

      await processBulkJobs(traitJobs, true);

      console.log(`ADDED ${traitJobs.length} ${task.contract.slug} MAGICEDEN TRAIT BID JOBS TO QUEUE`);
    }
    else if (task.bidType.toLowerCase() === "collection" && !traitBid) {

      const taskId = task._id
      const currentTask = currentTasks.find((task) => task._id === taskId)

      if (!currentTask?.running || !currentTask.selectedMarketplaces.map((market) => market.toLowerCase()).includes("magiceden")) {
        console.log(RED + '⚠️ Task is no longer active or magiceden not selected, skipping...' + RESET);
        return;
      }

      let colletionOffer = BigInt(offerPrice)
      const currentOfferKeyPattern = `*:${task._id}:magiceden:order:${task.contract.slug}:default`

      const marketDataPromise = task.outbidOptions.outbid ?
        fetchMagicEdenOffer("COLLECTION", task.wallet.address, task.contract.contractAddress) :
        null;

      const [orderKey, ...remainingOffers] = await redis.keys(currentOfferKeyPattern)

      const [ttl, offer] = await Promise.all([
        redis.ttl(orderKey),
        redis.get(orderKey)
      ]);

      if (remainingOffers.length > 0) {
        console.log(YELLOW + `⏰ Found ${remainingOffers.length} stale offers, cleaning up...` + RESET);
        const extractedOrderIds = await extractMagicedenOrderHash(remainingOffers)
        await queue.add(CANCEL_MAGICEDEN_BID, { orderIds: extractedOrderIds, privateKey: task.wallet.privateKey, orderKeys: remainingOffers }, { priority: CANCEL_PRIORITY.MAGICEDEN });
      }


      if (!task.outbidOptions.outbid) {
        if (ttl >= MIN_BID_DURATION) {
          const expiryTime = new Date(Date.now() + (ttl * 1000));
          console.log(BLUE + `Current bid for ${task.contract.slug} will expire at ${expiryTime.toISOString()} (in ${ttl} seconds), skipping...`.toUpperCase() + RESET);

          return;
        }

        if (offer) {
          const extractedOrderIds = await extractMagicedenOrderHash([orderKey])
          await queue.add(CANCEL_MAGICEDEN_BID, { orderIds: extractedOrderIds, privateKey: task.wallet.privateKey, orderKeys: remainingOffers }, { priority: CANCEL_PRIORITY.MAGICEDEN });
        }
      }

      else {
        const highestBid = await marketDataPromise;

        const highestBidAmount = typeof highestBid === 'object' && highestBid ? Number(highestBid.amount) : Number(highestBid);
        const owner = highestBid && typeof highestBid === 'object' ? highestBid.owner?.toLowerCase() : '';
        const isOwnBid = walletsArr
          .map(addr => addr.toLowerCase())
          .includes(owner);
        // CASE 1 - no top offer
        if (isOwnBid) {
          if (ttl > MIN_BID_DURATION) {
            return
          } else {
            if (offer) {
              const extractedOrderIds = await extractMagicedenOrderHash([orderKey])
              await queue.add(CANCEL_MAGICEDEN_BID, { orderIds: extractedOrderIds, privateKey: task.wallet.privateKey, orderKeys: remainingOffers }, { priority: CANCEL_PRIORITY.MAGICEDEN });

            }
          }
        }
        if (!isOwnBid && owner) {
          if (offer) {
            const extractedOrderIds = await extractMagicedenOrderHash([orderKey])
            await queue.add(CANCEL_MAGICEDEN_BID, { orderIds: extractedOrderIds, privateKey: task.wallet.privateKey, orderKeys: remainingOffers }, { priority: CANCEL_PRIORITY.MAGICEDEN });
          }

          if (highestBidAmount) {
            const outbidMargin = (task.outbidOptions.magicedenOutbidMargin || 0.0001) * 1e18
            colletionOffer = BigInt(highestBidAmount + outbidMargin)

            const offerPriceEth = Number(colletionOffer) / 1e18;
            if (maxBidPriceEth > 0 && offerPriceEth > maxBidPriceEth) {
              console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
              console.log(RED + `❌ Offer price ${offerPriceEth} WETH for ${task.contract.slug} collection bid exceeds max bid price ${maxBidPriceEth} WETH FOR MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
              console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
              return;
            }
          }
        }
      }

      const bidCount = getIncrementedBidCount(MAGICEDEN, task.contract.slug, task._id)
      await bidOnMagiceden(task._id, bidCount, WALLET_ADDRESS, contractAddress, 1, colletionOffer.toString(), WALLET_PRIVATE_KEY, task.contract.slug);
    }
  } catch (error) {
    console.error(RED + `Error processing MagicEden scheduled bid for task: ${task._id}` + RESET, error);
  }
}


async function processMagicedenTokenBid(data: IMagicedenTokenBidData) {
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

    const currentTask = currentTasks.find((task) => task._id === _id)
    if (!currentTask?.running || !currentTask.selectedMarketplaces.map((market) => market.toLowerCase()).includes("magiceden")) {
      console.log(RED + '⚠️ Task is no longer active or magiceden not selected, skipping...' + RESET);
      return;
    }

    const currentOfferKeyPattern = `*:${_id}:magiceden:order:${slug}:${tokenId}`
    const marketDataPromise = outbidOptions?.outbid ? fetchMagicEdenOffer("TOKEN", address, contractAddress, tokenId.toString()) : null

    const [orderKey, ...remainingOffers] = await redis.keys(currentOfferKeyPattern)
    const [ttl, offer] = await Promise.all([
      redis.ttl(orderKey),
      redis.get(orderKey)
    ]);
    const extractedOrderIds = await extractMagicedenOrderHash(remainingOffers)

    await queue.add(CANCEL_MAGICEDEN_BID, { orderIds: extractedOrderIds, privateKey, orderKeys: remainingOffers }, { priority: CANCEL_PRIORITY.MAGICEDEN });

    let collectionOffer = Number(offerPrice)

    if (!outbidOptions.outbid) {
      if (ttl >= MIN_BID_DURATION) {
        const expiryTime = new Date(Date.now() + (ttl * 1000)); // Convert seconds to milliseconds
        console.log(BLUE + `Current bid for ${slug}: ${tokenId} will expire at ${expiryTime.toISOString()} (in ${ttl} seconds), skipping...`.toUpperCase() + RESET);

        return;
      }

      if (offer) {
        const extractedOrderIds = await extractMagicedenOrderHash([orderKey])
        await queue.add(CANCEL_MAGICEDEN_BID, { privateKey, orderIds: extractedOrderIds, orderKeys: [orderKey] }, { priority: CANCEL_PRIORITY.MAGICEDEN })
      }
    }

    if (outbidOptions?.outbid) {
      const highestBid = await marketDataPromise;


      if (highestBid) {
        const highestBidAmount = typeof highestBid === 'object' && highestBid ? Number(highestBid.amount) : Number(highestBid);
        const owner = highestBid && typeof highestBid === 'object' ? highestBid.owner?.toLowerCase() : '';
        const isOwnBid = walletsArr
          .map(addr => addr.toLowerCase())
          .includes(owner);

        if (isOwnBid) {
          if (ttl > MIN_BID_DURATION) {
            return
          } else {
            if (offer) {
              const extractedOrderIds = await extractMagicedenOrderHash([orderKey])
              await queue.add(CANCEL_MAGICEDEN_BID, { privateKey, orderIds: extractedOrderIds }, { priority: CANCEL_PRIORITY.MAGICEDEN })
            }
          }
        } else {
          if (offer) {
            const extractedOrderIds = await extractMagicedenOrderHash([orderKey])
            await queue.add(CANCEL_MAGICEDEN_BID, { privateKey, orderIds: extractedOrderIds, orderKeys: [orderKey] }, { priority: CANCEL_PRIORITY.MAGICEDEN })
          }

          if (highestBidAmount) {
            const outbidMargin = (outbidOptions.openseaOutbidMargin || 0.0001) * 1e18
            collectionOffer = highestBidAmount + outbidMargin

            const offerPriceEth = Number(collectionOffer) / 1e18;
            if (maxBidPriceEth > 0 && offerPriceEth > maxBidPriceEth) {
              console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
              console.log(RED + `❌ Offer price ${offerPriceEth} ETH for ${slug} token ${tokenId} exceeds max bid price ${maxBidPriceEth} ETH FOR MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
              console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
              return;
            }
          }
        }
      }
    }
    const bidCount = getIncrementedBidCount(MAGICEDEN, slug, _id)

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

    const bidCount = getIncrementedBidCount(MAGICEDEN, slug, _id)

    const currentTask = currentTasks.find((task) => task._id === _id)
    if (!currentTask?.running || !currentTask.selectedMarketplaces.map((market) => market.toLowerCase()).includes("magiceden")) return

    await bidOnMagiceden(_id, bidCount, address, contractAddress, quantity, offerPrice, privateKey, slug, trait)
  } catch (error) {
    console.error(RED + `Error processing MagicEden trait bid for task: ${data?.slug}` + RESET, error);
  }
}

async function bulkCancelOpenseaBid(data: { privateKey: string, orderKey: string }) {
  try {
    const { privateKey, orderKey } = data

    const res = await cleanupOSKeys(orderKey)
    if (!res) return

    const { orderHash, offerKey, countKey } = res
    // Execute redis deletes and order cancellation in parallel
    if (orderHash) {
      await Promise.all([
        cancelOrder(orderHash, OPENSEA_PROTOCOL_ADDRESS, privateKey),
        redis.del(offerKey),
        redis.del(orderKey),
        redis.decr(countKey)
      ]);
    } else {
      await Promise.all([
        redis.del(offerKey),
        redis.del(orderKey)
      ]);
    }

  } catch (error) {
    console.log(error);
  }
}

async function cleanupOSKeys(key: string) {
  try {
    let offerKey: string = '';
    let countKey = ''
    const length = key.split(":").length
    if (length === 6) {
      const [bidCount, taskId, marketplace, orderType, slug, identifier] = key.split(':')
      countKey = `opensea:${taskId}:count`
      const uniqueKey = identifier === "default" ? "collection" : identifier;
      offerKey = `${bidCount}:${taskId}:opensea:${slug}:${uniqueKey}`

    } else if (length === 8) {
      const [bidCount, taskId, marketplace, orderType, slug, bidType, type, value] = key.split(':')
      const trait = JSON.stringify({ type: type, value: value })
      offerKey = `${bidCount}:${taskId}:opensea:${slug}:${trait}`
      countKey = `opensea:${taskId}:count`
    }
    const orderHash = await redis.get(key)
    return { orderHash, offerKey, countKey }

  } catch (error) {
    console.log(error);
  }
}

async function cleanupMagicedenKeys(keys: string[]) {
  try {
    await Promise.all(keys.map(async key => {
      let offerKey: string = '';
      let countKey = ''
      const length = key.split(":").length
      if (length === 6) {
        const [bidCount, taskId, marketplace, orderType, slug, identifier] = key.split(':')
        countKey = `magiceden:${taskId}:count`
        const uniqueKey = identifier === "default" ? "collection" : identifier;
        offerKey = `${bidCount}:${taskId}:opensea:${slug}:${uniqueKey}`
        redis.del(offerKey)
        redis.del(key)
        redis.decr(countKey)
      }
    }))

  } catch (error) {
    console.log(error);
  }
}

async function bulkCancelMagicedenBid(data: { orderIds: string[], privateKey: string, orderKeys: string[] }) {
  try {
    const { orderIds, privateKey, orderKeys } = data
    const parsedOrderIds = orderIds.map(orderId => {
      try {
        const parsed = JSON.parse(orderId);
        return parsed.orderId || null;
      } catch {
        return orderId;
      }
    }).filter(id => id !== null);
    if (parsedOrderIds.length > 0) {
      await Promise.all([
        cancelMagicEdenBid(parsedOrderIds, privateKey),
        cleanupMagicedenKeys(orderKeys)
      ])
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

setInterval(validateBidCount, 5000);

async function cleanupBlurKeys(key: string) {
  try {
    let offerKey: string = '';
    let countKey = ''
    const length = key.split(":").length
    if (length === 6) {
      const [bidCount, taskId, marketplace, orderType, slug, identifier] = key.split(':')
      countKey = `blur:${taskId}:count`
      const uniqueKey = identifier === "default" ? "collection" : identifier;
      offerKey = `${bidCount}:${taskId}:blur:${slug}:${uniqueKey}`

    } else if (length === 8) {
      const [bidCount, taskId, marketplace, orderType, slug, bidType, type, value] = key.split(':')
      const trait = JSON.stringify({ type: type, value: value })
      offerKey = `${bidCount}:${taskId}:blur:${slug}:${trait}`
      countKey = `blur:${taskId}:count`
    }
    const cancelPayload = await redis.get(key)
    return { cancelPayload, offerKey, countKey }

  } catch (error) {
    console.log(error);
  }
}

async function blukCancelBlurBid(data: BlurCancelPayload) {
  try {
    const { orderKey, privateKey } = data

    if (!data) return

    const res = await cleanupBlurKeys(orderKey)
    if (!res) return

    const { cancelPayload, offerKey, countKey } = res
    const cancelData = JSON.parse(cancelPayload as string)

    if (cancelData) {
      await Promise.all([
        cancelBlurBid({ payload: cancelData, privateKey }),
        redis.del(offerKey),
        redis.del(orderKey),
        redis.decr(countKey)
      ]);
    } else {
      await Promise.all([
        redis.del(offerKey),
        redis.del(orderKey)
      ]);
    }
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
  } else {
    offerPriceEth = bidPrice.min;
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

// Store bid counts in memory with a Map
const bidCounts = new Map<string, number>();

function getIncrementedBidCount(marketplace: string, slug: string, taskId: string): string {
  const countKey = `${marketplace}:${slug}`;
  const currentCount = bidCounts.get(countKey) || 0;
  const newCount = currentCount + 1;
  bidCounts.set(countKey, newCount);
  return `${newCount}:${taskId}`;
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


let marketplaceIntervals: { [key: string]: NodeJS.Timeout } = {};
function subscribeToCollections(tasks: ITask[]) {
  try {
    tasks.forEach(async (task) => {
      // Create a unique subscription key for this collection
      const subscriptionKey = `${task.contract.slug}`;

      const clientId = task.user.toString()

      // Skip if already subscribed
      if (activeSubscriptions.has(subscriptionKey)) {
        console.log(`Already subscribed to collection: ${task.contract.slug}`);

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              event: "ping",
              clientId
            })
          );
        }

        // send a ping message here
        return;
      }

      let retries = 0;
      const maxRetries = 5;
      const retryDelay = 1000; // 1 second

      while ((!ws || ws.readyState !== WebSocket.OPEN) && retries < maxRetries) {
        console.error(RED + `WebSocket is not open for subscribing to collections: ${task.contract.slug}. Retrying...` + RESET);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        retries++;
      }

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error(RED + `Failed to open WebSocket after ${maxRetries} retries for: ${task.contract.slug}` + RESET);
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
        activeSubscriptions.add(subscriptionKey);
        console.log('----------------------------------------------------------------------');
        console.log(`SUBSCRIBED TO COLLECTION: ${task.contract.slug} OPENSEA`);
        console.log('----------------------------------------------------------------------');

        const intervalKey = `opensea:${task.contract.slug}`;
        if (!marketplaceIntervals[intervalKey]) {
          marketplaceIntervals[intervalKey] = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                event: "ping",
                clientId: task.user.toString(),
              }));
            } else {
              clearInterval(marketplaceIntervals[intervalKey]);
              delete marketplaceIntervals[intervalKey];
            }
          }, 30000);
        }
      }

      if (connectToMagiceden && task.outbidOptions.counterbid && task.running) {
        if (!activeSubscriptions.has(subscriptionKey)) {
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
          activeSubscriptions.add(subscriptionKey);
          console.log('----------------------------------------------------------------------');
          console.log(`SUBSCRIBED TO COLLECTION: ${task.contract.slug} MAGICEDEN`);
          console.log('----------------------------------------------------------------------');

          const intervalKey = `magiceden:${task.contract.slug}`;
          if (!marketplaceIntervals[intervalKey]) {
            marketplaceIntervals[intervalKey] = setInterval(() => {
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  event: "ping",
                  clientId: task.user.toString(),
                }));
              } else {
                clearInterval(marketplaceIntervals[intervalKey]);
                delete marketplaceIntervals[intervalKey];
              }
            }, 30000);
          }
        }
      }

      if (connectToBlur && task.outbidOptions.counterbid && task.running) {
        if (!activeSubscriptions.has(subscriptionKey)) {
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
      }
    })
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
  orderKey: string;
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
        console.error(RED + `Error details:`, error);
        console.error(`Error message: ${error.message}`);
        console.error(`Error code: ${error.code}`);
        console.error(RED + `Error: Wallet ${task.wallet.address} could not approve the ${name} as a spender. Task has been stopped.`.toUpperCase() + RESET);
      }
      return false;
    }
  }) ?? false;
}

// In the hasActivePrioritizedJobs function:
async function hasActivePrioritizedJobs(task: ITask): Promise<boolean> {
  const taskId = task._id.toString();

  // Get the lock info
  const lockInfo = taskLocks.get(taskId);

  if (lockInfo) {
    const currentTime = Date.now();

    if (lockInfo.locked && currentTime < lockInfo.lockUntil) {
      return true;
    }
  }

  const jobs = await queue.getJobs(['prioritized', 'active']);
  const baseKey = `${task._id}-${task.contract?.slug}`;

  const hasJobs = jobs.some(job => {
    const jobId = job?.id || '';
    return jobId.startsWith(baseKey);
  });

  return hasJobs;
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

// Add near the top with other constants
// Add these helper functions
const abortedTasks: string[] = [];

function markTaskAsAborted(taskId: string) {
  if (!abortedTasks.includes(taskId)) {
    abortedTasks.push(taskId);
  }
}

function removeTaskFromAborted(taskId: string) {
  const index = abortedTasks.indexOf(taskId);
  if (index > -1) {
    abortedTasks.splice(index, 1);
  }
}

function isTaskAborted(taskId: string): boolean {
  return abortedTasks.includes(taskId);
}

interface OpenseaCounterBidJobData {
  _id: string;
  bidCount: string;
  address: string;
  privateKey: string;
  slug: string;
  colletionOffer: number;
  creatorFees: IFee;
  enforceCreatorFee: any;
  expiry: number;
  asset?: {
    contractAddress: string;
    tokenId: number;
  };
  trait?: string;
}

interface IProcessOpenseaTokenBidData {
  _id: string;
  address: string;
  privateKey: string;
  slug: string;
  offerPrice: number;
  creatorFees: IFee;
  enforceCreatorFee: boolean;
  asset: {
    contractAddress: string;
    tokenId: number;
  };
  expiry: number;
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  };
  maxBidPriceEth: number;
}

interface IMagicedenTokenBidData {
  _id: string;
  address: string;
  contractAddress: string;
  quantity: number;
  offerPrice: string;
  expiration: string;
  privateKey: string;
  slug: string;
  tokenId: number;
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  };
  maxBidPriceEth: number;
}

// Create separate bid rate states for each marketplace
const bidRateState = {
  opensea: {
    bids: [] as { timestamp: number, count: number }[]
  },
  magiceden: {
    bids: [] as { timestamp: number, count: number }[]
  }
};

const BID_RATE_WINDOW = 10; // 10 seconds window

export function trackBidRate(marketplace: 'opensea' | 'magiceden') {
  const now = Math.floor(Date.now() / 1000);

  // Add new bid to the appropriate marketplace
  bidRateState[marketplace].bids.push({
    timestamp: now,
    count: 1
  });

  // Remove entries older than our window
  const cutoff = now - BID_RATE_WINDOW;
  bidRateState[marketplace].bids = bidRateState[marketplace].bids.filter(bid =>
    bid.timestamp > cutoff
  );

  // Get count of bids in window
  const count = bidRateState[marketplace].bids.length;
  const rate = count / BID_RATE_WINDOW;

  console.log(`Current ${marketplace} bid rate: ${rate.toFixed(2)} bids/second (${count} bids in last 10 seconds)`);
  return rate;
}

interface IOpenseaBidParams {
  taskId: string;
  bidCount: string;
  walletAddress: string;
  walletPrivateKey: string;
  slug: string;
  offerPrice: number;
  creatorFees: IFee;
  enforceCreatorFee: boolean;
  expiry: number;
}