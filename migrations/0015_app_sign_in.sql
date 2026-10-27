-- Desktop app sign-in: the app signs in through the player's own browser (Discord's page), then the API hands the
-- browser back to the app on 127.0.0.1 with a one-time code. app_challenge is the SHA-256 (base64url) of a secret
-- only the app holds (PKCE), so the code alone is useless; such handoffs can't be redeemed by the website's exchange.
ALTER TABLE auth_handoffs ADD COLUMN app_challenge TEXT;
