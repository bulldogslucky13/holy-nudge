-- 0005: who coordinates which queue. Seeing a WHOLE queue (Unassigned, Behind and Team scoped to it, and the
-- morning summary push) needs a row here, or staff (leaders.is_admin). Nothing else grants it: Lead's queue
-- managers no longer do (every team member is a manager of their queue in the real data).
--
-- leader_id = the app's leader row (the person holding the personal link), NOT a Lead id, so a coordinator
--             added by name works before they are matched to Lead.
-- queue_key = a queue id, or a queue's exact name, as Lead has it (same convention as config excludedQueues).
--             A key equal to some queue's id matches that queue only; otherwise it matches by exact name.
--             A key that matches no queue grants nothing.
--
-- Written by scripts/add-leader.mjs --coordinator-of. When a merge deletes a spare leader row
-- (src/db/index.ts applyMatches / setMatch), its rows move to the surviving row in the same batch, and any
-- left behind by a deleted leader are removed there too (the cascade below is a backstop, not relied on).
-- A future rebuild of `leaders` (DROP TABLE, as in 0003) would cascade-delete these: copy them aside first.
--
-- Additive only: one new table, empty. No existing row or table changes. With it empty, only staff see whole
-- queues (the code no longer falls back to Lead queue managers): fail closed.

CREATE TABLE queue_coordinators (
  leader_id  INTEGER NOT NULL REFERENCES leaders(id) ON DELETE CASCADE,
  queue_key  TEXT NOT NULL CHECK (length(trim(queue_key)) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (leader_id, queue_key)
);
