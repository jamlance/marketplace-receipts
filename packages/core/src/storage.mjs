// Shared S3 object storage — image/file uploads that return a public URL.
// Reuses the same AWS creds as ses.mjs/sns.mjs. Env:
//   AWS_REGION (or S3_REGION), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//   S3_BUCKET           — target bucket (required)
//   S3_PUBLIC_BASE      — optional CDN/custom-domain base (no trailing slash);
//                         else https://<bucket>.s3.<region>.amazonaws.com
//
//   import { putObject, storageConfigured, isAllowedImage } from "@inkress/apps-core/storage";
//   const { url } = await putObject({ key: `campaigns/${mid}/${uuid}.jpg`, body, contentType });
//
// Fails closed with a clear error when the bucket/creds are absent so an app
// that advertises uploads never silently no-ops.

import crypto from "node:crypto";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

let client = null;
const region = () => process.env.S3_REGION || process.env.AWS_REGION || "us-east-1";
const bucket = () => process.env.S3_BUCKET || "";

export function storageConfigured() {
  return Boolean(bucket() && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

function getClient() {
  if (!storageConfigured()) throw new Error("Storage is not configured (missing S3_BUCKET or AWS creds).");
  if (!client) {
    client = new S3Client({
      region: region(),
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
    });
  }
  return client;
}

export function publicUrlFor(key) {
  const base = (process.env.S3_PUBLIC_BASE || "").replace(/\/+$/, "");
  if (base) return `${base}/${key}`;
  return `https://${bucket()}.s3.${region()}.amazonaws.com/${key}`;
}

const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };
const FILE_TYPES = { ...IMAGE_TYPES, "application/pdf": "pdf" };
export function isAllowedImage(contentType) { return Boolean(IMAGE_TYPES[String(contentType || "").toLowerCase()]); }
export function isAllowedFile(contentType) { return Boolean(FILE_TYPES[String(contentType || "").toLowerCase()]); }
export function extFor(contentType, fallback = "bin") { return FILE_TYPES[String(contentType || "").toLowerCase()] || fallback; }

/**
 * Upload bytes to S3 and return its URL.
 * @param {{ key?:string, prefix?:string, body:Buffer|Uint8Array|string, contentType:string,
 *           public?:boolean, cacheSeconds?:number }} opts
 * @returns {Promise<{ url:string, key:string }>}
 */
export async function putObject(opts) {
  const { body, contentType } = opts;
  if (!body) throw new Error("putObject: empty body.");
  const key = opts.key || `${(opts.prefix || "uploads").replace(/\/+$/, "")}/${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${extFor(contentType)}`;
  const cmd = new PutObjectCommand({
    Bucket: bucket(), Key: key, Body: body, ContentType: contentType || "application/octet-stream",
    ...(opts.public !== false ? { ACL: "public-read" } : {}),
    CacheControl: `public, max-age=${Number(opts.cacheSeconds) || 31536000}`,
  });
  await getClient().send(cmd);
  return { url: publicUrlFor(key), key };
}

export async function deleteObject(key) {
  if (!key) return;
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

// Decode a data: URL (e.g. from a browser FileReader) into bytes + content type.
export function decodeDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const contentType = m[1] || "application/octet-stream";
  const body = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  return { contentType, body };
}
