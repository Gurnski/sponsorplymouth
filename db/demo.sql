-- Made-up dares for local previews only. Do not run this against the live database.
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
INSERT INTO settings (key, value) VALUES
  ('group_name', 'Plymouth walking group'),
  ('charity_name', 'our chosen charity'),
  ('walk_date', 'Saturday 14 November')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
