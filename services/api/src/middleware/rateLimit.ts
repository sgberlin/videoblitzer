import rateLimit from "express-rate-limit";

export const contactRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
export const uploadRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
export const jobRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });
