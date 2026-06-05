type LogEnv = Record<string, string | undefined>;

const REDACTED = "[redacted]";

function defaultEnv(): LogEnv {
  return ((globalThis as unknown as { process?: { env?: LogEnv } }).process?.env) ?? {};
}

export function isProductionLikeLogEnv(env: LogEnv = defaultEnv()): boolean {
  const nodeEnv = (env.NODE_ENV || "").toLowerCase();
  const appEnv = (env.APP_ENV || env.ENVIRONMENT || "").toLowerCase();
  const frontendUrl = env.FRONTEND_URL || "";
  return nodeEnv === "production"
    || nodeEnv === "staging"
    || appEnv === "production"
    || appEnv === "staging"
    || frontendUrl === "https://comptoir.cosmobot.fr"
    || frontendUrl === "https://staging.comptoir.cosmobot.fr";
}

export function redactEmailAddress(value: string): string {
  return value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email:redacted]");
}

export function redactPhoneNumber(value: string): string {
  return value
    .replace(/(?<![\w])\+\d(?:[\s().-]*\d){7,14}(?![\w])/g, "[phone:redacted]")
    .replace(/(?<![\w])0[1-9](?:[\s.-]?\d{2}){4}(?![\w])/g, "[phone:redacted]");
}

export function redactSensitiveString(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return redactPhoneNumber(redactEmailAddress(
    text
      .replace(/(\/public\/onboarding\/)[^/?#\s]+/g, `$1${REDACTED}`)
      .replace(/(\/dossier\/)[^/?#\s]+/g, `$1${REDACTED}`)
      .replace(/([?&](?:hub\.)?(?:token|verify_token|secret|access_token|refresh_token|code)=)[^&#\s]+/gi, `$1${REDACTED}`)
      .replace(/([?&](?:phone|email)=)[^&#\s]+/gi, `$1${REDACTED}`),
  ));
}

export function formatLogMessagePreview(message: string, env: LogEnv = defaultEnv()): string {
  if (isProductionLikeLogEnv(env)) return `[message:redacted chars=${message.length}]`;
  return redactSensitiveString(message);
}

export function formatLogObject(value: unknown, env: LogEnv = defaultEnv()): string {
  if (!isProductionLikeLogEnv(env)) return redactSensitiveString(JSON.stringify(value));
  if (!value || typeof value !== "object") return `[${typeof value}:redacted]`;
  const keys = Object.keys(value as Record<string, unknown>);
  return `[object:redacted keys=${keys.join(",")}]`;
}
