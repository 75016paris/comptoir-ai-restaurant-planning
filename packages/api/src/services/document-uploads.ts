import {
  ALLOWED_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  PENDING_KEY_RE,
  buildDocumentKey,
  buildPendingKey,
  getStorage,
  isAllowedMimeType,
  isObjectStorageActive,
} from "./storage.js";

const PRESIGN_PUT_TTL = 5 * 60;
const PRESIGN_GET_TTL = 60;
const MAGIC_BYTES_TO_READ = 32;
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heis", "heim", "hevm", "hevs", "mif1", "msf1"]);

export interface PresignedUploadInput {
  restaurantId: string;
  userId: string;
  documentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface PresignedUploadResult {
  uploadUrl: string;
  storageKey: string;
  expiresAt: string;
}

export class StorageInactiveError extends Error {
  constructor() {
    super("Object storage is not active (STORAGE_PROVIDER!=ovh)");
  }
}

export class InvalidUploadError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function hasHeifBrand(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== "ftyp") return false;
  for (let i = 8; i + 4 <= bytes.length; i += 4) {
    if (HEIF_BRANDS.has(ascii(bytes, i, i + 4))) return true;
  }
  return false;
}

export function hasValidDocumentMagic(mimeType: string, bytes: Uint8Array): boolean {
  const type = mimeType.trim().toLowerCase();
  if (type === "application/pdf") return bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-";
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") return bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (type === "image/webp") return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
  if (type === "image/heic" || type === "image/heif") return hasHeifBrand(bytes);
  return false;
}

export function assertDocumentMagic(mimeType: string, bytes: Uint8Array): void {
  if (!hasValidDocumentMagic(mimeType, bytes)) {
    throw new InvalidUploadError("Le contenu du fichier ne correspond pas au type déclaré", 400);
  }
}

export async function presignDocumentUpload(input: PresignedUploadInput): Promise<PresignedUploadResult> {
  if (!isObjectStorageActive()) throw new StorageInactiveError();

  const mimeType = input.mimeType?.trim().toLowerCase();
  if (!isAllowedMimeType(mimeType)) {
    throw new InvalidUploadError(
      `Type de fichier non autorisé (autorisés : ${[...ALLOWED_MIME_TYPES].join(", ")})`,
      400,
    );
  }
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new InvalidUploadError("Taille de fichier invalide", 400);
  }
  if (input.size > MAX_DOCUMENT_BYTES) {
    throw new InvalidUploadError("Fichier trop volumineux (max 5 Mo)", 413);
  }

  // Uploads land in the orphan-safe `pending/` prefix; commitUploadedObject
  // promotes them to the per-restaurant tree once the metadata POST validates.
  const storageKey = buildPendingKey({ documentId: input.documentId, filename: input.filename });
  const uploadUrl = await getStorage().presignPut(storageKey, mimeType, PRESIGN_PUT_TTL);
  return {
    uploadUrl,
    storageKey,
    expiresAt: new Date(Date.now() + PRESIGN_PUT_TTL * 1000).toISOString(),
  };
}

export interface CommitUploadInput {
  pendingKey: string;
  restaurantId: string;
  userId: string;
  filename: string;
  expectedMimeType: string;
}

export interface CommittedUpload {
  storageKey: string;
  size: number;
  contentType: string;
}

// Promote an uploaded object from the orphan-safe `pending/` prefix to its
// per-restaurant final key. HEADs the pending object, validates size + mime,
// COPIES to the final key, deletes pending. The bucket lifecycle rule on
// `pending/` is the safety net for orphans we fail to delete here.
export async function commitUploadedObject(input: CommitUploadInput): Promise<CommittedUpload> {
  if (!isObjectStorageActive()) throw new StorageInactiveError();

  if (!PENDING_KEY_RE.test(input.pendingKey)) {
    throw new InvalidUploadError("storageKey invalide", 400);
  }

  const head = await getStorage().headObject(input.pendingKey);
  if (!head) {
    throw new InvalidUploadError("Aucun fichier trouvé pour cette clé — l'upload a-t-il abouti ?", 400);
  }
  if (head.size > MAX_DOCUMENT_BYTES) {
    throw new InvalidUploadError("Fichier trop volumineux (max 5 Mo)", 413);
  }
  if (head.contentType.toLowerCase() !== input.expectedMimeType.toLowerCase()) {
    throw new InvalidUploadError("Type MIME du fichier ne correspond pas à la déclaration", 400);
  }
  const prefix = await getStorage().readObjectPrefix(input.pendingKey, MAGIC_BYTES_TO_READ);
  if (!prefix) {
    throw new InvalidUploadError("Impossible de lire le fichier uploadé", 400);
  }
  assertDocumentMagic(input.expectedMimeType, prefix);

  // The pending key's UUID is opaque — generate a fresh id for the final key,
  // tied to the user/restaurant that owns the resulting row.
  const documentId = crypto.randomUUID();
  const storageKey = buildDocumentKey({
    restaurantId: input.restaurantId,
    userId: input.userId,
    documentId,
    filename: input.filename,
  });

  await getStorage().copyObject(input.pendingKey, storageKey, input.expectedMimeType);
  await getStorage()
    .deleteObject(input.pendingKey)
    .catch((err) => console.warn("[storage] failed to delete pending key", input.pendingKey, err));

  return { storageKey, size: head.size, contentType: head.contentType };
}

export interface ProxyUploadInput {
  restaurantId: string;
  userId: string;
  filename: string;
  mimeType: string;
  body: Buffer;
}

// Server-side upload: client POSTs the file bytes to the API, the API puts
// them straight into the per-restaurant final key. Avoids the browser→OVH
// CORS preflight that the presign+PUT flow requires. Mirrors the validation
// rules of presignDocumentUpload + commitUploadedObject.
export async function proxyUploadDocument(input: ProxyUploadInput): Promise<CommittedUpload> {
  const mimeType = input.mimeType?.trim().toLowerCase();
  if (!isAllowedMimeType(mimeType)) {
    throw new InvalidUploadError(
      `Type de fichier non autorisé (autorisés : ${[...ALLOWED_MIME_TYPES].join(", ")})`,
      400,
    );
  }
  const size = input.body.length;
  if (size <= 0) throw new InvalidUploadError("Fichier vide", 400);
  if (size > MAX_DOCUMENT_BYTES) throw new InvalidUploadError("Fichier trop volumineux (max 5 Mo)", 413);
  assertDocumentMagic(mimeType, input.body.subarray(0, MAGIC_BYTES_TO_READ));
  if (!isObjectStorageActive()) throw new StorageInactiveError();

  const documentId = crypto.randomUUID();
  const storageKey = buildDocumentKey({
    restaurantId: input.restaurantId,
    userId: input.userId,
    documentId,
    filename: input.filename,
  });
  await getStorage().putObject(storageKey, input.body, mimeType);
  return { storageKey, size, contentType: mimeType };
}

export async function presignDocumentDownload(storageKey: string): Promise<{ url: string; expiresAt: string }> {
  if (!isObjectStorageActive()) throw new StorageInactiveError();
  const url = await getStorage().presignGet(storageKey, PRESIGN_GET_TTL);
  return {
    url,
    expiresAt: new Date(Date.now() + PRESIGN_GET_TTL * 1000).toISOString(),
  };
}

export async function deleteStoredObject(storageKey: string): Promise<void> {
  if (!isObjectStorageActive()) return;
  try {
    await getStorage().deleteObject(storageKey);
  } catch (err) {
    console.warn("[storage] deleteObject failed for", storageKey, err);
  }
}
