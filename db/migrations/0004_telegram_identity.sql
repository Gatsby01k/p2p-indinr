-- =====================================================================
-- INRP2P — migration 0004: Telegram identity
--
-- The product runs as a Telegram Mini App as well as a web app, and a
-- person arriving through Telegram has no email address to give. So the
-- account gains a second way of being identified, and `email` stops being
-- mandatory.
--
-- ⚠ STILL NO CREDENTIAL. There is no password column here and none may be
-- added. A Telegram identity is proven by an HMAC that Telegram itself
-- computes over the launch parameters using the bot token — verified
-- server-side in src/server/telegram/verify.ts — never by anything the
-- browser claims about itself.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Email becomes optional, but an account must still be identifiable.
--
-- The shape check is rewritten rather than dropped: a NULL email is now
-- allowed, but a malformed one still is not. `app_user_has_identity` is
-- what stops the table ever holding a row nobody could sign in as.
-- ---------------------------------------------------------------------

ALTER TABLE sandbox.app_user ALTER COLUMN email DROP NOT NULL;

ALTER TABLE sandbox.app_user DROP CONSTRAINT app_user_email_shape;
ALTER TABLE sandbox.app_user
  ADD CONSTRAINT app_user_email_shape
  CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+$');

-- ---------------------------------------------------------------------
-- 2. The Telegram identity.
--
-- `telegram_id` is Telegram's own numeric user id. It is UNIQUE, which is
-- the whole security property of the link: one Telegram account maps to
-- exactly one INRP2P account and can never silently take over a second.
--
-- Telegram ids exceed 2^31, so BIGINT is required, not INTEGER.
-- ---------------------------------------------------------------------

ALTER TABLE sandbox.app_user ADD COLUMN IF NOT EXISTS telegram_id       BIGINT NULL;
ALTER TABLE sandbox.app_user ADD COLUMN IF NOT EXISTS telegram_username TEXT   NULL;
ALTER TABLE sandbox.app_user ADD COLUMN IF NOT EXISTS photo_url         TEXT   NULL;

ALTER TABLE sandbox.app_user ADD CONSTRAINT app_user_telegram_uq UNIQUE (telegram_id);

ALTER TABLE sandbox.app_user
  ADD CONSTRAINT app_user_has_identity
  CHECK (email IS NOT NULL OR telegram_id IS NOT NULL);

ALTER TABLE sandbox.app_user
  ADD CONSTRAINT app_user_telegram_id_positive
  CHECK (telegram_id IS NULL OR telegram_id > 0);

-- A stored photo URL is a link to Telegram's CDN, not an image we hold.
-- Constrain it to https so a crafted value cannot become a javascript: or
-- data: URI on a page that renders it.
ALTER TABLE sandbox.app_user
  ADD CONSTRAINT app_user_photo_url_https
  CHECK (photo_url IS NULL OR photo_url ~ '^https://');

COMMENT ON COLUMN sandbox.app_user.telegram_id IS
  'Telegram numeric user id, proven by the Mini App initData HMAC. UNIQUE: one '
  'Telegram account maps to exactly one INRP2P account. Never operator-granting.';
