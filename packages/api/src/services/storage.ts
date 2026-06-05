import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageObjectHead {
  size: number;
  contentType: string;
}

export interface StorageAdapter {
  readonly provider: "ovh" | "sqlite";
  presignPut(key: string, mimeType: string, ttlSeconds: number): Promise<string>;
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  putObject(key: string, body: Buffer, mimeType: string): Promise<void>;
  copyObject(srcKey: string, destKey: string, mimeType?: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<StorageObjectHead | null>;
  readObjectPrefix(key: string, maxBytes: number): Promise<Buffer | null>;
}

class OvhStorage implements StorageAdapter {
  readonly provider = "ovh" as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: {
    region: string;
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  }) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
  }

  async presignPut(key: string, mimeType: string, ttlSeconds: number) {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mimeType,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds });
  }

  async presignGet(key: string, ttlSeconds: number) {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds });
  }

  async putObject(key: string, body: Buffer, mimeType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
      }),
    );
  }

  async copyObject(srcKey: string, destKey: string, mimeType?: string) {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destKey,
        CopySource: `/${this.bucket}/${encodeURIComponent(srcKey).replace(/%2F/g, "/")}`,
        ...(mimeType
          ? { ContentType: mimeType, MetadataDirective: "REPLACE" as const }
          : {}),
      }),
    );
  }

  async deleteObject(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async headObject(key: string): Promise<StorageObjectHead | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? "application/octet-stream",
      };
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async readObjectPrefix(key: string, maxBytes: number): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${Math.max(0, maxBytes - 1)}` }),
      );
      const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) return Buffer.alloc(0);
      return Buffer.from(await body.transformToByteArray());
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }
}

class SqliteStorage implements StorageAdapter {
  readonly provider = "sqlite" as const;

  async presignPut(): Promise<string> {
    throw new Error(
      "SqliteStorage does not support presigned URLs — uploads must POST base64 to the API",
    );
  }
  async presignGet(): Promise<string> {
    throw new Error(
      "SqliteStorage does not support presigned URLs — downloads return base64 in JSON",
    );
  }
  async putObject(): Promise<void> {
    throw new Error("SqliteStorage.putObject is not implemented — write directly to documents.data");
  }
  async copyObject(): Promise<void> {
    throw new Error("SqliteStorage.copyObject is not implemented");
  }
  async deleteObject(): Promise<void> {
    throw new Error("SqliteStorage.deleteObject is not implemented — DELETE the documents row");
  }
  async headObject(): Promise<StorageObjectHead | null> {
    return null;
  }
  async readObjectPrefix(): Promise<Buffer | null> {
    return null;
  }
}

let cached: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (cached) return cached;
  const provider = (process.env.STORAGE_PROVIDER ?? "sqlite").toLowerCase();
  if (provider === "ovh") {
    const region = process.env.OVH_OS_REGION;
    const endpoint = process.env.OVH_OS_ENDPOINT;
    const bucket = process.env.OVH_OS_BUCKET;
    const accessKeyId = process.env.OVH_OS_ACCESS_KEY;
    const secretAccessKey = process.env.OVH_OS_SECRET_KEY;
    if (!region || !endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "STORAGE_PROVIDER=ovh requires OVH_OS_REGION, OVH_OS_ENDPOINT, OVH_OS_BUCKET, OVH_OS_ACCESS_KEY, OVH_OS_SECRET_KEY",
      );
    }
    cached = new OvhStorage({ region, endpoint, bucket, accessKeyId, secretAccessKey });
  } else {
    cached = new SqliteStorage();
  }
  return cached;
}

export function resetStorageForTests() {
  cached = null;
}

const SAFE_EXT = /^[a-z0-9]{1,10}$/i;

function safeExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const raw = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return SAFE_EXT.test(raw) ? raw : "bin";
}

function safePathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

export const PENDING_KEY_PREFIX = "pending/";
export const PENDING_KEY_RE = /^pending\/[^/]+\.[a-z0-9]{1,10}$/i;

export function buildDocumentKey(opts: {
  restaurantId: string | number;
  userId: string | number;
  documentId: string;
  filename: string;
}): string {
  return `restaurants/${safePathSegment(opts.restaurantId)}/users/${safePathSegment(opts.userId)}/${opts.documentId}.${safeExt(opts.filename)}`;
}

export function buildPendingKey(opts: { documentId: string; filename: string }): string {
  return `${PENDING_KEY_PREFIX}${opts.documentId}.${safeExt(opts.filename)}`;
}

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

export function isAllowedMimeType(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return ALLOWED_MIME_TYPES.has(mimeType.toLowerCase());
}

export function isObjectStorageActive(): boolean {
  return getStorage().provider === "ovh";
}
