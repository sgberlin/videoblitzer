import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import { config } from "../config";

type RedisStoreOptions = ConstructorParameters<typeof RedisStore>[0];
type RedisSendCommand = Extract<RedisStoreOptions, { sendCommand: unknown }>["sendCommand"];

let sendRedisCommand: RedisSendCommand | undefined;
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
  sendRedisCommand = (...args: string[]) => client.sendCommand(args);
}

function redisStore(prefix: string) {
  return sendRedisCommand ? new RedisStore({ sendCommand: sendRedisCommand, prefix }) : undefined;
}

function limiter(limit: number, prefix: string) {
  return rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, store: redisStore(prefix) });
}

export const contactRateLimit = limiter(5, "rl:contact:");
export const uploadRateLimit = limiter(30, "rl:upload:");
export const jobRateLimit = limiter(40, "rl:job:");
