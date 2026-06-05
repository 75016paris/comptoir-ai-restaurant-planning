const DEFAULT_DEMO_CHAT_SECRET = "dev-demo-secret";

export function isProductionLikeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || env.NODE_ENV === "staging";
}

export function isUsableDemoChatSecret(secret: string | undefined): secret is string {
  return !!secret && secret !== DEFAULT_DEMO_CHAT_SECRET;
}

export function assertDemoChatSecretForProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProductionLikeEnv(env)) return;
  if (!isUsableDemoChatSecret(env.DEMO_CHAT_SECRET)) {
    throw new Error("DEMO_CHAT_SECRET must be set to a non-default value in production/staging");
  }
}
