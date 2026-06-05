-- Bind public dossier tokens to the restaurant context that created them.
-- Existing tokens fall back to users.restaurant_id so old links keep working.
ALTER TABLE onboarding_tokens ADD COLUMN restaurant_id text REFERENCES restaurants(id);

UPDATE onboarding_tokens
SET restaurant_id = (
  SELECT users.restaurant_id
  FROM users
  WHERE users.id = onboarding_tokens.user_id
)
WHERE restaurant_id IS NULL;

CREATE INDEX idx_onboarding_tokens_restaurant_id ON onboarding_tokens(restaurant_id);
