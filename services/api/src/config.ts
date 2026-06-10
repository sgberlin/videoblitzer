import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();
dotenv.config({ path: process.env.API_ENV_PATH ?? "/var/www/videoblitzer-api/.env" });

const envSchema = z.object({
  APP_NAME: z.string().default("VideoBlitzer"),
  APP_URL: z.string().url().default("https://app.videoblitzer.com"),
  API_URL: z.string().url().default("https://api.videoblitzer.com"),
  OWNER_EMAIL: z.string().email().default("gizlenweb@gmail.com"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET_NAME: z.string().default("videoblitzer-videos"),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PORT: z.coerce.number().default(8080),
});

export const config = envSchema.parse(process.env);
