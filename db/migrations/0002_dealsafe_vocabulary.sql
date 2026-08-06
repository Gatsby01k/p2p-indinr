-- =====================================================================
-- INRP2P — DealSafe India, migration 0002: VOCABULARY ONLY
--
-- This file adds enum members and nothing else.
--
-- WHY IT IS SPLIT OUT. PostgreSQL permits `ALTER TYPE ... ADD VALUE`
-- inside a transaction, but forbids *using* the new member in the same
-- transaction — a CHECK constraint or an INSERT naming it fails with
-- "unsafe use of new value of enum type". The migration runner wraps each
-- file in its own BEGIN/COMMIT, so putting the additions in their own file
-- is what makes 0003 free to reference them.
--
-- Still no money. See the schema comment in 0001: this schema holds no
-- funds and gains no custody table here.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Scenario. The product offers three, and the engine stays direction-
-- neutral: `direction` names which asset leaves each seat.
--
--   INR_TO_INR    protected payment between two people, rupees both sides
--   INR_TO_USDT   buy USDT — the creator pays INR
--   USDT_TO_INR   sell USDT — the creator supplies USDT
--
-- The two seats are unchanged, and deliberately so: FIAT_SIDE is always
-- the side that SENDS the INR, CRYPTO_SIDE is always the side that
-- RECEIVES it. In an exchange the receiving side also supplies the USDT.
-- One rule, three scenarios, no new role vocabulary.
-- ---------------------------------------------------------------------

ALTER TYPE sandbox.direction ADD VALUE IF NOT EXISTS 'INR_TO_INR';

-- ---------------------------------------------------------------------
-- Deal states.
--
-- DISPUTED  a participant raised a problem; release is PAUSED, not
--           reversed, and only an operator ruling moves it onward.
-- EXPIRED   the payment window lapsed with no claim. Terminal, and it is
--           reached by an explicit sweep, never by a client timer.
-- REFUNDED  an operator returned the protected value to its origin.
--
-- Nothing here completes, releases or refunds on a timer. Every one of
-- these is a person acting or an operator ruling.
-- ---------------------------------------------------------------------

ALTER TYPE sandbox.deal_state ADD VALUE IF NOT EXISTS 'DISPUTED';
ALTER TYPE sandbox.deal_state ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE sandbox.deal_state ADD VALUE IF NOT EXISTS 'REFUNDED';
