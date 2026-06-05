import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { transcribeAudio } from "./stt.js";

const origFetch = globalThis.fetch;
const origKey = process.env.OPENAI_API_KEY;
const origSttKey = process.env.STT_API_KEY;
const origBase = process.env.STT_BASE_URL;
const origModel = process.env.STT_MODEL;
const origLang = process.env.STT_LANGUAGE;

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.STT_API_KEY;
  delete process.env.STT_BASE_URL;
  delete process.env.STT_MODEL;
  delete process.env.STT_LANGUAGE;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = origKey;
  if (origSttKey === undefined) delete process.env.STT_API_KEY; else process.env.STT_API_KEY = origSttKey;
  if (origBase === undefined) delete process.env.STT_BASE_URL; else process.env.STT_BASE_URL = origBase;
  if (origModel === undefined) delete process.env.STT_MODEL; else process.env.STT_MODEL = origModel;
  if (origLang === undefined) delete process.env.STT_LANGUAGE; else process.env.STT_LANGUAGE = origLang;
});

describe("transcribeAudio", () => {
  test("posts multipart to DeepInfra and returns trimmed text", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    let capturedForm: FormData | undefined;
    globalThis.fetch = (async (input: any, init?: any) => {
      capturedUrl = String(input);
      capturedAuth = init?.headers?.["Authorization"] ?? "";
      capturedForm = init?.body as FormData;
      return new Response(JSON.stringify({ text: "  Bonjour Bernardo  " }), { status: 200 });
    }) as unknown as typeof fetch;

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const out = await transcribeAudio(bytes, "audio/ogg");

    expect(out).toBe("Bonjour Bernardo");
    expect(capturedUrl).toBe("https://api.deepinfra.com/v1/openai/audio/transcriptions");
    expect(capturedAuth).toBe("Bearer test-key");
    expect(capturedForm?.get("model")).toBe("openai/whisper-large-v3-turbo");
    expect(capturedForm?.get("language")).toBe("fr");
  });

  test("throws on non-2xx with response body in the error", async () => {
    globalThis.fetch = (async () => new Response("upstream boom", { status: 502 })) as unknown as typeof fetch;
    await expect(transcribeAudio(new Uint8Array([1]), "audio/ogg")).rejects.toThrow(/502.*upstream boom/);
  });

  test("throws when no API key is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(transcribeAudio(new Uint8Array([1]), "audio/ogg")).rejects.toThrow(/STT_API_KEY/);
  });
});
