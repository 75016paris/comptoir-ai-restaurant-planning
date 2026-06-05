-- Magic-link tokens for the no-login onboarding/profile-completion page (id:dpae-magic).
-- Worker clicks a tokenized URL from the invitation email and lands on /onboarding/<token>
-- where they can fill DPAE-mandatory fields without password friction.
-- Multi-visit: token stays valid until expires_at so the worker can return and finish later.
CREATE TABLE onboarding_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX onboarding_tokens_user_idx ON onboarding_tokens(user_id);
