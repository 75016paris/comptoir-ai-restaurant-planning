import { describe, expect, test } from "bun:test";
import { assertDocumentMagic, hasValidDocumentMagic, InvalidUploadError } from "./document-uploads.js";
import { buildDocumentKey, buildPendingKey } from "./storage.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const webp = Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "binary");
const heic = Buffer.from("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00", "binary");

describe("document upload magic-byte validation", () => {
  test("accepts valid PDF and image signatures", () => {
    expect(hasValidDocumentMagic("application/pdf", Buffer.from("%PDF-1.7\n"))).toBe(true);
    expect(hasValidDocumentMagic("image/jpeg", jpeg)).toBe(true);
    expect(hasValidDocumentMagic("image/png", png)).toBe(true);
    expect(hasValidDocumentMagic("image/webp", webp)).toBe(true);
    expect(hasValidDocumentMagic("image/heic", heic)).toBe(true);
  });

  test("rejects a fake PDF with the wrong magic bytes", () => {
    expect(hasValidDocumentMagic("application/pdf", Buffer.from("not actually a pdf"))).toBe(false);
    expect(() => assertDocumentMagic("application/pdf", Buffer.from("not actually a pdf"))).toThrow(InvalidUploadError);
  });

  test("rejects content whose signature does not match the declared MIME type", () => {
    expect(hasValidDocumentMagic("image/png", jpeg)).toBe(false);
    expect(hasValidDocumentMagic("application/pdf", png)).toBe(false);
  });
});

describe("document object keys", () => {
  test("namespaces final objects by restaurant and user", () => {
    expect(buildDocumentKey({
      restaurantId: "resto-1",
      userId: "worker-1",
      documentId: "doc-1",
      filename: "contrat.pdf",
    })).toBe("restaurants/resto-1/users/worker-1/doc-1.pdf");
  });

  test("encodes path segments and normalizes unsafe extensions", () => {
    expect(buildDocumentKey({
      restaurantId: "resto/../2",
      userId: "worker/3",
      documentId: "doc-2",
      filename: "scan.final.exe?",
    })).toBe("restaurants/resto%2F..%2F2/users/worker%2F3/doc-2.bin");
  });

  test("keeps pending upload keys outside tenant namespaces", () => {
    expect(buildPendingKey({ documentId: "pending-1", filename: "rib.png" })).toBe("pending/pending-1.png");
  });
});
