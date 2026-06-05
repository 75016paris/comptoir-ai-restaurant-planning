/**
 * HiGHS worker spawn wrapper.
 *
 * Isolates each HiGHS solve in a fresh Node worker_threads Worker so a WASM
 * crash (RuntimeError: Aborted) can't poison subsequent solves. Keep-it-simple
 * strategy: one Worker per solve. The 2s cold-start is acceptable because
 * HiGHS is only hit as a fallback — CP-SAT handles the hot path.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const WORKER_PATH = fileURLToPath(new URL("./highs-worker.ts", import.meta.url));

export class HiGHSWorkerCrashed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HiGHSWorkerCrashed";
  }
}

export class HiGHSWorkerTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`HiGHS worker exceeded ${timeoutMs}ms timeout`);
    this.name = "HiGHSWorkerTimeout";
  }
}

export interface HighsResult {
  Status: string;
  ObjectiveValue?: number;
  Columns: Record<string, { Primal: number }>;
  [k: string]: any;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Solve an LP/MIP model in a dedicated worker.
 *
 * Rejects with HiGHSWorkerCrashed on WASM abort or worker exit, and with
 * HiGHSWorkerTimeout when the solve exceeds `timeoutMs`. Either way, the
 * worker is terminated — the next call gets a pristine WASM instance.
 */
export function solveInWorker(
  model: string,
  options: object = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HighsResult> {
  return new Promise<HighsResult>((resolve, reject) => {
    const worker = new Worker(WORKER_PATH);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      reject(new HiGHSWorkerTimeout(timeoutMs));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
    };

    worker.once("message", (msg: { ok: true; result: HighsResult } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (msg.ok) {
        resolve(msg.result);
      } else {
        reject(new HiGHSWorkerCrashed(msg.error));
      }
      worker.terminate().catch(() => {});
    });

    worker.once("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HiGHSWorkerCrashed(err?.message ? String(err.message) : String(err)));
      worker.terminate().catch(() => {});
    });

    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HiGHSWorkerCrashed(`HiGHS worker exited with code ${code} before replying`));
    });

    worker.postMessage({ model, options });
  });
}
