import { config } from "dotenv"
import Bottleneck from "bottleneck";

config()

export const RATE_LIMIT = 8

const limiter = new Bottleneck({
  minTime: 1 / RATE_LIMIT,
});

export default limiter