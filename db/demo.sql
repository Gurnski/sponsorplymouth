-- Made-up dares and fundraisers for local previews only. Do not run this against the live database.
INSERT INTO dares (code, target_id, title, detail, suggested_by, status) VALUES
  ('DARE-K7QM', (SELECT id FROM targets WHERE slug = 'group'), 'Everyone walks the last mile in fancy dress', 'Costumes must survive a bog.', 'Jess', 'approved'),
  ('DARE-3HVT', (SELECT id FROM targets WHERE slug = 'group'), 'Sing the whole way up the final tor', 'Any song. Loudly.', 'Tom', 'approved'),
  ('DARE-W9PC', (SELECT id FROM targets WHERE slug = 'group'), 'Packed lunch made entirely by a rival flat', '', '', 'approved'),
  ('DARE-M2XR', (SELECT id FROM targets WHERE slug = 'group'), 'Carry a full-size traffic cone all day', 'It has to come home again too.', 'Mo', 'approved'),
  ('DARE-P6ZD', (SELECT id FROM targets WHERE slug = 'group'), 'Swap boots at every checkpoint', '', 'Anon', 'pending'),
  ('DARE-T4BN', (SELECT id FROM targets WHERE slug = 'daniel'), 'Walk the route in a dress', 'Walking boots allowed.', 'Sam', 'approved'),
  ('DARE-R8GF', (SELECT id FROM targets WHERE slug = 'daniel'), 'Answer only in pirate voice until lunch', '', 'Priya', 'approved'),
  ('DARE-Q5JH', (SELECT id FROM targets WHERE slug = 'daniel'), 'Cold plunge at the end of the walk', 'Somewhere safe, with people watching.', 'Lee', 'approved');
WITH n(i) AS (VALUES (1), (2), (3), (4), (5), (6))
  INSERT INTO votes (dare_id, voter) SELECT (SELECT id FROM dares WHERE code = 'DARE-K7QM'), 'demo-' || i FROM n;
WITH n(i) AS (VALUES (1), (2), (3), (4))
  INSERT INTO votes (dare_id, voter) SELECT (SELECT id FROM dares WHERE code = 'DARE-3HVT'), 'demo-' || i FROM n;
WITH n(i) AS (VALUES (1), (2), (3))
  INSERT INTO votes (dare_id, voter) SELECT (SELECT id FROM dares WHERE code = 'DARE-W9PC'), 'demo-' || i FROM n;
INSERT INTO votes (dare_id, voter) SELECT id, 'demo-1' FROM dares WHERE code = 'DARE-M2XR';
INSERT INTO pledges (dare_id, amount_pence, donor_name, source, status) VALUES
  ((SELECT id FROM dares WHERE code = 'DARE-T4BN'), 1200, 'Sam', 'donor', 'confirmed'),
  ((SELECT id FROM dares WHERE code = 'DARE-R8GF'), 700, 'Priya', 'donor', 'confirmed'),
  ((SELECT id FROM dares WHERE code = 'DARE-Q5JH'), 500, 'Lee', 'donor', 'confirmed'),
  ((SELECT id FROM dares WHERE code = 'DARE-Q5JH'), 1000, 'Kit', 'donor', 'unconfirmed');

UPDATE fundraisers SET target_pence = 50000, event_date = 'Saturday 14 November' WHERE slug = 'dartmoor';

-- Fundraisers 3 to 5: a live event, a live challenge and a finished event.
-- Fundraiser 2 is the Plymouth Hoe draft from the migration and stays a draft.
INSERT INTO fundraisers (slug, title, type, summary, body, target_pence, event_date, place, donate_url, manual_total_pence, status, sort) VALUES
  ('quiz-night', 'Charity Quiz Night', 'event',
   'An evening of trivia and prizes. Bring a team of up to six, or come alone and we''ll find you one.',
   'Doors open at 7pm and the first round starts at half past.' || char(10) || char(10) || 'Entry is a donation on the door, and there''s a raffle between rounds. This is made-up demo text.',
   30000, 'Thursday 3 December, 7pm', 'Students'' Union', 'https://www.justgiving.com/fundraising/cachpage-daniel-rea', 11000, 'live', 3),
  ('sponsored-walk', 'Sponsored Walk', 'challenge',
   'A group walk along the coast path to build fitness for the trek.',
   'We''re walking a long stretch of the coast path in one day. Sponsor us by the mile or just chip in. This is made-up demo text.',
   25000, 'Sunday 17 January', 'South West Coast Path', 'https://www.justgiving.com/fundraising/cachpage-daniel-rea', 5239, 'live', 4),
  ('bake-sale', 'Freshers'' Bake Sale', 'event',
   'Cakes outside the library. Sold out by two o''clock.',
   'Thanks to everyone who baked and everyone who bought. This is made-up demo text.',
   10000, 'October', 'Outside the library', '', 13450, 'finished', 5);
