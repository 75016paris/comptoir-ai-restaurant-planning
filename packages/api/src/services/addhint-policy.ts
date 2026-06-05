/**
 * Per-preset AddHint enable/disable policy.
 *
 * Background: the 2026-04-24 cross-preset AddHint sweep measured warm-start
 * hints across all 5 presets. Four shipped clean; `economique` showed a
 * −0.0124 paired `consistency` regression (n=35, 2·SE=0.0108), which is a
 * >2·SE ship-blocker per the équipe-stable Step 1 rulebook. Rather than
 * retire AddHint everywhere, we gate it off per-preset until the regression
 * is understood.
 *
 * Env contract: `ADDHINT_DISABLED_PRESETS` is a comma-separated list of
 * lowercase preset names (matching `PresetName` in
 * `packages/shared/src/weight-config.ts`). Whitespace around entries is
 * trimmed. Empty/unset → every preset keeps hints enabled (current default).
 * Matching is case-sensitive — the preset names in `PRESETS` are all
 * lowercase kebab-case, and keeping the env matching strict keeps a typo
 * like `Economique` from silently no-op-ing.
 *
 * The parse result is memoized against the raw env value so the helper is
 * cheap to call on the hint-load hot path; a test reset hook flushes the
 * cache so unit tests can exercise multiple env values in one run.
 */

const ENV_VAR = "ADDHINT_DISABLED_PRESETS";

let cachedEnv: string | undefined = undefined;
let cachedSet: Set<string> = new Set();

function parseDisabledPresets(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) out.add(trimmed);
  }
  return out;
}

function disabledPresets(): Set<string> {
  const raw = process.env[ENV_VAR];
  if (raw !== cachedEnv) {
    cachedEnv = raw;
    cachedSet = parseDisabledPresets(raw);
  }
  return cachedSet;
}

/**
 * Returns `true` when AddHint should be loaded for solves on `presetName`,
 * `false` when the preset is listed in `ADDHINT_DISABLED_PRESETS`. `null` /
 * `undefined` / unknown preset names are treated as enabled (the default
 * fallback preset is `equilibre`, which is not currently disabled anywhere
 * — keeps stored data that predates a removed preset solving cleanly).
 */
export function addHintEnabledForPreset(presetName: string | null | undefined): boolean {
  if (!presetName) return true;
  return !disabledPresets().has(presetName);
}

/** Test-only: flush the memoized parse so tests can switch env values. */
export function __resetAddHintPolicy(): void {
  cachedEnv = undefined;
  cachedSet = new Set();
}
