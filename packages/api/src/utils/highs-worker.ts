/**
 * HiGHS WASM worker.
 *
 * Runs in a Node worker_threads Worker so a WASM crash (RuntimeError: Aborted)
 * only kills the worker, not the main process. One message in, one reply out,
 * then the worker exits.
 *
 * Message in:  { model: string, options?: object }
 * Message out: { ok: true, result } | { ok: false, error: string }
 */

import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("highs-worker must be spawned via worker_threads");
}

parentPort.once("message", async (msg: { model: string; options?: object }) => {
  try {
    const mod: any = await import("highs");
    const highs = await (mod.default || mod)();
    const result = highs.solve(msg.model, msg.options);
    parentPort!.postMessage({ ok: true, result });
  } catch (e: any) {
    parentPort!.postMessage({
      ok: false,
      error: e?.message ? String(e.message) : String(e),
    });
  } finally {
    // Always exit so the main thread doesn't need to terminate() on success.
    process.exit(0);
  }
});
