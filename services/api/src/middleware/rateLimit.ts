import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import { config } from "../config";

let redisStore: RedisStore | undefined;
const isProduction = config.NODE_ENV === "production";

if (!config.REDIS_URL && isProduction) {
  throw new Error("REDIS_URL is required in production for consistent API rate limiting.");
}

if (config.REDIS_URL) {
  const client = createClient({ url: config.REDIS_URL });
  client.connect().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[rate-limit] redis connection failed", message);
    if (isProduction) process.exit(1);
  });
  redisStore = new RedisStore({ sendCommand: (...args: string[]) => client.sendCommand(args) });
}

function limiter(limit: number) {
  return rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, store: redisStore });
}

export const contactRateLimit = limiter(5);
export const uploadRateLimit = limiter(30);
export const jobRateLimit = limiter(40);
