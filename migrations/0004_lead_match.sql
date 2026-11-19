-- 0004: staff can decide a leader's Lead (ChMS) match by hand.
--
-- leaders.match_by_hand = 1 when staff set or cleared this row's chms_individual_id from the Team tab.
-- Automatic name matching (src/core/match.ts) never touches such a row, so a cleared match stays cleared.
--
-- Additive only: one new column with a constant default. No table rebuild, so no foreign-key cascade:
-- every leader row, link hash and push subscription is untouched. Existing rows get 0 (not decided by hand).

ALTER TABLE leaders ADD COLUMN match_by_hand INTEGER NOT NULL DEFAULT 0;
