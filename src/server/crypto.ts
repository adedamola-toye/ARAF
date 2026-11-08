import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";
import { config } from "./config";

/** AES-256-GCM encryption for restricted fields (BVN, TIN). Output: v1:<iv>:<tag>:<ciphertext> (base64). */
export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", config.fieldKey, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}
export function decryptField(enc: string): string {
  const [v, iv, tag, ct] = enc.split(":");
  if (v !== "v1") throw new Error("Unknown field encryption version");
  const d = createDecipheriv("aes-256-gcm", config.fieldKey, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

/** Binary encryption for stored objects. Layout: 'WB1' | iv(12) | tag(16) | ciphertext */
export function encryptBlob(data: Buffer, key = config.storageKey): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([Buffer.from("WB1"), iv, c.getAuthTag(), ct]);
}
export function decryptBlob(blob: Buffer, key = config.storageKey): Buffer {
  if (blob.subarray(0, 3).toString() !== "WB1") throw new Error("Unknown blob format");
  const iv = blob.subarray(3, 15);
  const tag = blob.subarray(15, 31);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(31)), d.final()]);
}

export function hmac(value: string): string {
  return createHmac("sha256", config.hmacKey).update(value).digest("hex");
}
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
export function randomOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
/** Cryptographically secure uniform pick. */
export function securePick<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error("Cannot pick from empty list");
  return items[randomInt(0, items.length)];
}
