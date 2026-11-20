import { cleanText, isClosed, isJustGivingUrl, isVoterId, makeCode, parsePounds, parseWinnerCount, rankBoard, slugify } from './logic.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const encoder = new TextEncoder();

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  return toHex(await sha256(`${env.ADMIN_PASSWORD ?? ''}:${ip}`)).slice(0, 16);
}

async function recentCount(env, kind, hash, windowSeconds) {
  const since = Date.now() - windowSeconds * 1000;
  await env.DB.prepare('DELETE FROM rate_events WHERE at < ?').bind(Date.now() - 86400000).run();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE kind = ? AND ip_hash = ? AND at >= ?')
    .bind(kind, hash, since).first();
  return row.n;
}

const recordEvent = (env, kind, hash) =>
  env.DB.prepare('INSERT INTO rate_events (kind, ip_hash, at) VALUES (?, ?, ?)').bind(kind, hash, Date.now()).run();

async function enforceLimit(request, env, kind, max, windowSeconds) {
  const hash = await ipHash(request, env);
  if ((await recentCount(env, kind, hash, windowSeconds)) >= max) {
    throw new HttpError(429, 'Too many tries from this connection. Wait a while and try again.');
  }
  await recordEvent(env, kind, hash);
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'The admin password has not been set up yet.');
  const hash = await ipHash(request, env);
  if ((await recentCount(env, 'login-fail', hash, 900)) >= 10) {
    throw new HttpError(429, 'Too many wrong passwords. Wait 15 minutes and try again.');
  }
  const header = request.headers.get('authorization') ?? '';
  const given = await sha256(header.replace(/^Bearer /, ''));
  const expected = await sha256(env.ADMIN_PASSWORD);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= given[i] ^ expected[i];
  if (difference !== 0) {
    await recordEvent(env, 'login-fail', hash);
    throw new HttpError(401, 'That password is wrong.');
  }
}

async function readBody(request) {
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // Falls through to the error below.
  }
  throw new HttpError(400, 'The request could not be read.');
}

function requireText(input, maxLength, tooLongMessage) {
  const text = cleanText(input, maxLength);
  if (text === null) throw new HttpError(400, tooLongMessage);
  return text;
}

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(results.map((row) => [row.key, row.value]));
}

async function assertOpen(env) {
  const settings = await getSettings(env);
  if (isClosed(settings.closes_at)) throw new HttpError(403, 'The dare list has closed.');
}

async function getBoard(env) {
  const settings = await getSettings(env);
  const [{ results: targets }, { results: dares }] = await Promise.all([
    env.DB.prepare('SELECT id, slug, name, kind, jg_url FROM targets WHERE active = 1 ORDER BY sort, id').all(),
    env.DB.prepare(`
      SELECT d.id, d.code, d.target_id, d.title, d.detail, d.suggested_by,
        COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.amount_pence END), 0) AS total_pence,
        COALESCE(SUM(CASE WHEN p.status = 'unconfirmed' THEN p.amount_pence END), 0) AS pending_pence,
        (SELECT COUNT(*) FROM votes v WHERE v.dare_id = d.id) AS votes
      FROM dares d LEFT JOIN pledges p ON p.dare_id = d.id
      WHERE d.status = 'approved'
      GROUP BY d.id`).all(),
  ]);
  const groupEnabled = settings.group_enabled === '1';
  const boards = targets.filter((target) => groupEnabled || target.kind !== 'group').map((target) => {
    const isGroup = target.kind === 'group';
    const winnerCount = Number(isGroup ? settings.group_winners : settings.walker_winners);
    const own = dares.filter((dare) => dare.target_id === target.id);
    return { ...target, winnerCount, ...rankBoard(own, winnerCount, isGroup ? 'votes' : 'total_pence') };
  });
  return {
    settings: {
      challenge_title: settings.challenge_title,
      group_name: settings.group_name,
      charity_name: settings.charity_name,
      walk_date: settings.walk_date,
      closes_at: settings.closes_at,
    },
    closed: isClosed(settings.closes_at),
    total_pence: boards.reduce((sum, board) => sum + board.dares.reduce((s, dare) => s + dare.total_pence, 0), 0),
    boards,
  };
}

const GROUP_NO_MONEY = 'Group dares are free to vote on, so they do not take donations.';

const findLiveDare = (env, code) =>
  env.DB.prepare("SELECT d.id, t.kind FROM dares d JOIN targets t ON t.id = d.target_id WHERE d.code = ? AND d.status = 'approved'")
    .bind(code).first();

async function createDare(request, env) {
  const body = await readBody(request);
  if (body.website) return json({ ok: true }, 201); // Honeypot: only bots fill this in.
  await assertOpen(env);
  const title = requireText(body.title, 80, 'Keep the dare to 80 characters.');
  if (title.length < 3) throw new HttpError(400, 'Describe the dare in a few words.');
  const detail = requireText(body.detail, 240, 'Keep the details to 240 characters.');
  const suggestedBy = requireText(body.suggested_by, 40, 'Keep your name to 40 characters.');
  const target = await env.DB.prepare('SELECT id, kind FROM targets WHERE id = ? AND active = 1').bind(Number(body.target_id) || 0).first();
  if (!target) throw new HttpError(400, 'Choose who the dare is for.');
  if (target.kind === 'group' && (await getSettings(env)).group_enabled !== '1') throw new HttpError(400, 'Group dares are switched off.');
  // Generous because campus Wi-Fi and halls can put many people behind one address.
  await enforceLimit(request, env, 'dare', 20, 3600);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode(crypto.getRandomValues(new Uint8Array(4)));
    try {
      await env.DB.prepare('INSERT INTO dares (code, target_id, title, detail, suggested_by) VALUES (?, ?, ?, ?, ?)')
        .bind(code, target.id, title, detail, suggestedBy).run();
      return json({ ok: true }, 201);
    } catch (error) {
      if (!String(error.message).includes('UNIQUE')) throw error;
    }
  }
  throw new HttpError(500, 'The dare could not be saved. Try again.');
}

async function createPledge(request, env) {
  const body = await readBody(request);
  if (body.website) return json({ ok: true }, 201);
  await assertOpen(env);
  const amount = parsePounds(body.amount);
  if (amount === null) throw new HttpError(400, 'Enter the amount in pounds, like 10 or 7.50.');
  const donorName = requireText(body.donor_name, 60, 'Keep the name to 60 characters.');
  const dare = await findLiveDare(env, String(body.code ?? ''));
  if (!dare) throw new HttpError(404, 'That dare is no longer on the list.');
  if (dare.kind === 'group') throw new HttpError(400, GROUP_NO_MONEY);
  await enforceLimit(request, env, 'pledge', 40, 3600);
  await env.DB.prepare('INSERT INTO pledges (dare_id, amount_pence, donor_name) VALUES (?, ?, ?)')
    .bind(dare.id, amount, donorName).run();
  return json({ ok: true }, 201);
}

// Voting again on the same dare takes the vote back, so a mistaken tap can be undone.
async function toggleVote(request, env) {
  const body = await readBody(request);
  await assertOpen(env);
  if (!isVoterId(body.voter)) throw new HttpError(400, 'Your vote could not be read. Refresh the page and try again.');
  const dare = await findLiveDare(env, String(body.code ?? ''));
  if (!dare || dare.kind !== 'group') throw new HttpError(404, 'That dare is no longer on the list.');
  if ((await getSettings(env)).group_enabled !== '1') throw new HttpError(400, 'Group dares are switched off.');
  // Generous because campus Wi-Fi and halls can put many people behind one address.
  await enforceLimit(request, env, 'vote', 300, 3600);
  const added = await env.DB.prepare('INSERT OR IGNORE INTO votes (dare_id, voter) VALUES (?, ?)').bind(dare.id, body.voter).run();
  if (!added.meta.changes) {
    await env.DB.prepare('DELETE FROM votes WHERE dare_id = ? AND voter = ?').bind(dare.id, body.voter).run();
  }
  return json({ voted: Boolean(added.meta.changes) });
}

async function adminOverview(env) {
  const [dares, pledges, targets, settings] = await Promise.all([
    env.DB.prepare(`
      SELECT d.id, d.code, d.title, d.detail, d.suggested_by, d.status, d.created_at, t.name AS target_name
      FROM dares d JOIN targets t ON t.id = d.target_id
      WHERE d.status != 'rejected' ORDER BY d.created_at DESC`).all(),
    env.DB.prepare(`
      SELECT p.id, p.amount_pence, p.donor_name, p.source, p.created_at, d.code, d.title, t.name AS target_name, t.jg_url
      FROM pledges p JOIN dares d ON d.id = p.dare_id JOIN targets t ON t.id = d.target_id
      WHERE p.status = 'unconfirmed' ORDER BY p.created_at`).all(),
    env.DB.prepare('SELECT id, slug, name, kind, jg_url, active FROM targets ORDER BY sort, id').all(),
    getSettings(env),
  ]);
  return { dares: dares.results, pledges: pledges.results, targets: targets.results, settings };
}

async function setStatus(request, env, table, id, allowed) {
  const { status } = await readBody(request);
  if (!allowed.includes(status)) throw new HttpError(400, 'That status is not allowed.');
  const { meta } = await env.DB.prepare(`UPDATE ${table} SET status = ? WHERE id = ?`).bind(status, id).run();
  if (!meta.changes) throw new HttpError(404, 'That item no longer exists.');
  return json({ ok: true });
}

async function adminAddPledge(request, env) {
  const body = await readBody(request);
  const amount = parsePounds(body.amount);
  if (amount === null) throw new HttpError(400, 'Enter the amount in pounds, like 10 or 7.50.');
  const donorName = requireText(body.donor_name, 60, 'Keep the name to 60 characters.');
  const code = String(body.code ?? '').trim().toUpperCase();
  const dare = await findLiveDare(env, code);
  if (!dare) throw new HttpError(404, `No live dare has the code ${code || '(blank)'}.`);
  if (dare.kind === 'group') throw new HttpError(400, GROUP_NO_MONEY);
  await env.DB.prepare("INSERT INTO pledges (dare_id, amount_pence, donor_name, source, status) VALUES (?, ?, ?, 'admin', 'confirmed')")
    .bind(dare.id, amount, donorName).run();
  return json({ ok: true }, 201);
}

function readTargetFields(body) {
  const name = requireText(body.name, 40, 'Keep the name to 40 characters.');
  if (!name) throw new HttpError(400, 'Enter a name.');
  const jgUrl = String(body.jg_url ?? '').trim();
  if (jgUrl && !isJustGivingUrl(jgUrl)) throw new HttpError(400, 'The donation link must be an https://www.justgiving.com address.');
  return { name, jgUrl };
}

async function adminAddWalker(request, env) {
  const { name, jgUrl } = readTargetFields(await readBody(request));
  const base = slugify(name);
  for (let suffix = 1; suffix < 50; suffix++) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`;
    const clash = await env.DB.prepare('SELECT 1 FROM targets WHERE slug = ?').bind(slug).first();
    if (!clash) {
      await env.DB.prepare("INSERT INTO targets (slug, name, kind, jg_url, sort) VALUES (?, ?, 'walker', ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM targets))")
        .bind(slug, name, jgUrl).run();
      return json({ ok: true }, 201);
    }
  }
  throw new HttpError(400, 'Too many walkers share that name.');
}

async function adminUpdateTarget(request, env, id) {
  const body = await readBody(request);
  const { name, jgUrl } = readTargetFields(body);
  const active = body.active === false ? 0 : 1;
  const target = await env.DB.prepare('SELECT kind FROM targets WHERE id = ?').bind(id).first();
  if (!target) throw new HttpError(404, 'That walker no longer exists.');
  if (target.kind === 'group' && !active) throw new HttpError(400, 'The group board cannot be hidden.');
  await env.DB.prepare('UPDATE targets SET name = ?, jg_url = ?, active = ? WHERE id = ?').bind(name, jgUrl, active, id).run();
  return json({ ok: true });
}

async function adminUpdateSettings(request, env) {
  const body = await readBody(request);
  const groupWinners = parseWinnerCount(body.group_winners);
  const walkerWinners = parseWinnerCount(body.walker_winners);
  if (groupWinners === null || walkerWinners === null) throw new HttpError(400, 'Winner counts must be between 1 and 10.');
  const closesAt = String(body.closes_at ?? '').trim();
  if (closesAt && !Number.isFinite(Date.parse(closesAt))) throw new HttpError(400, 'That closing time is not a valid date.');
  const title = requireText(body.challenge_title, 60, 'Keep the challenge title to 60 characters.');
  if (!title) throw new HttpError(400, 'Enter a challenge title.');
  const values = {
    challenge_title: title,
    group_name: requireText(body.group_name, 60, 'Keep the group name to 60 characters.'),
    charity_name: requireText(body.charity_name, 80, 'Keep the charity name to 80 characters.'),
    walk_date: requireText(body.walk_date, 40, 'Keep the walk date to 40 characters.'),
    closes_at: closesAt,
    group_winners: String(groupWinners),
    walker_winners: String(walkerWinners),
    group_enabled: ['on', '1', true].includes(body.group_enabled) ? '1' : '0',
  };
  const statement = env.DB.prepare('UPDATE settings SET value = ? WHERE key = ?');
  await env.DB.batch(Object.entries(values).map(([key, value]) => statement.bind(value, key)));
  return json({ ok: true });
}

async function route(request, env, url) {
  const { pathname: path } = url;
  const { method } = request;

  if (method === 'GET' && path === '/api/board') return json(await getBoard(env));
  if (method === 'POST' && path === '/api/dares') return createDare(request, env);
  if (method === 'POST' && path === '/api/pledges') return createPledge(request, env);
  if (method === 'POST' && path === '/api/votes') return toggleVote(request, env);

  if (path.startsWith('/api/admin/')) {
    await requireAdmin(request, env);
    if (method === 'GET' && path === '/api/admin/overview') return json(await adminOverview(env));
    if (method === 'POST' && path === '/api/admin/pledges') return adminAddPledge(request, env);
    if (method === 'POST' && path === '/api/admin/walkers') return adminAddWalker(request, env);
    if (method === 'PUT' && path === '/api/admin/settings') return adminUpdateSettings(request, env);
    const match = /^\/api\/admin\/(dares|pledges|targets)\/(\d+)$/.exec(path);
    if (match && method === 'PUT') {
      const id = Number(match[2]);
      if (match[1] === 'dares') return setStatus(request, env, 'dares', id, ['approved', 'rejected']);
      if (match[1] === 'pledges') return setStatus(request, env, 'pledges', id, ['confirmed', 'rejected']);
      return adminUpdateTarget(request, env, id);
    }
  }
  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: 'Something went wrong on the server. Try again.' }, 500);
    }
  },
};
