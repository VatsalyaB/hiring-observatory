-- Closes a hole in invariant 1 found while auditing Task 2.
--
-- 001_core.sql guards UPDATE and DELETE, but TRUNCATE is a third way to destroy raw data and
-- fires neither trigger. Confirmed by experiment: `begin; truncate public.raw_listings;` reported
-- TRUNCATE TABLE. The project's central claim is that invariants are enforced by the database
-- rather than by convention, and that claim was only two-thirds true.
--
-- TRUNCATE requires table-owner rights, so the practical risk was low — but "low risk" is not the
-- standard the invariant sets, and a guard that is cheap to add should not be left off.
--
-- Numbered 001b deliberately so Task 3's 002_wall.sql and Task 5's 003_canary.sql keep the numbers
-- the plan gives them. The migration runner sorts by filename: 001_core < 001b_truncate_guard < 002_wall.

drop trigger if exists raw_listings_no_truncate on raw_listings;
create trigger raw_listings_no_truncate
  before truncate on raw_listings
  for each statement execute function raw_listings_immutable();

-- The private tier gets the same guard when it is created in 002_wall.sql — see that file.

-- Fix a latent defect seeded by scripts/verify-schema.mjs: the synthetic 'selftest' source was
-- created publishable = true. Invariant 3 governs what may cross to the public database, and a
-- test fixture must never be eligible. Harmless today because nothing publishes yet; a landmine
-- from M6 onward, when aggregates start crossing.
update sources set publishable = false where id = 'selftest';
