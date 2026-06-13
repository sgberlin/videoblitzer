import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import { config } from "../config";

let redisStore: RedisStore | undefined;

if (config.REDIS_URL) {
  const client = createClient({ url: config.REDIS_URL });
  client.connect().catch((error) => console.error("[rate-limit] redis connection failed", error instanceof Error ? error.message : error));
  redisStore = new RedisStore({ sendCommand: (...args: string[]) => client.sendCommand(args) });
}

function limiter(limit: number) {
  return rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, store: redisStore });
}

export const contactRateLimit = limiter(5);
export const uploadRateLimit = limiter(30);
export const jobRateLimit = limiter(40);
