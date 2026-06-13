import { lookup } from "node:dns/promises";
import net from "node:net";

const directMediaExtensions = /\.(mp4|mov|webm|mkv)(\?|$)/i;
const blockedPlatformHosts = /(^|\.)((youtube\.com)|(youtu\.be)|(vimeo\.com)|(twitch\.tv)|(facebook\.com)|(instagram\.com)|(tiktok\.com)|(x\.com)|(twitter\.com))$/i;

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}

function isPrivateIpv6(ip: string) {
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

export function isBlockedVideoPlatformUrl(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    return blockedPlatformHosts.test(url.hostname);
  } catch {
    return false;
  }
}

export function sourceFormatFromUrl(sourceUrl: string): "mp4" | "mov" | "webm" | "mkv" | null {
  try {
    const extension = new URL(sourceUrl).pathname.split(".").pop()?.toLowerCase();
    if (extension === "mp4" || extension === "mov" || extension === "webm" || extension === "mkv") return extension;
    return null;
  } catch {
    return null;
  }
}

export function isDirectMediaUrl(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    return ["http:", "https:"].includes(url.protocol) && directMediaExtensions.test(url.pathname);
  } catch {
    return false;
  }
}

export function isVideoContentType(contentType: string | null) {
  const mediaType = contentType?.toLowerCase().split(";")[0]?.trim();
  return Boolean(mediaType?.startsWith("video/"));
}

export async function assertPublicHttpUrl(sourceUrl: string) {
  const url = new URL(sourceUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https URLs are supported.");
  if (!url.hostname || url.username || url.password) throw new Error("URL must not include credentials.");
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) throw new Error("Localhost URLs are not allowed.");
  const parsedIp = net.isIP(url.hostname);
  const addresses = parsedIp ? [{ address: url.hostname, family: parsedIp }] : await lookup(url.hostname, { all: true, verbatim: false });
  if (!addresses.length) throw new Error("Source host could not be resolved.");
  for (const record of addresses) {
    if (record.family === 4 && isPrivateIpv4(record.address)) throw new Error("Private IPv4 addresses are not allowed.");
    if (record.family === 6 && isPrivateIpv6(record.address)) throw new Error("Private IPv6 addresses are not allowed.");
  }
}

export async function validateDirectMediaImportUrl(sourceUrl: string) {
  if (isBlockedVideoPlatformUrl(sourceUrl)) {
    throw new Error("Video platform pages cannot be downloaded here. Use Capture Screen Video if you have permission to record your own accessible source.");
  }
  if (!isDirectMediaUrl(sourceUrl)) throw new Error("Only direct media file URLs ending in .mp4, .mov, .webm, or .mkv are supported.");
  await assertPublicHttpUrl(sourceUrl);
}
