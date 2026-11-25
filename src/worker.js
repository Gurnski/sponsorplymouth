import {
  FUNDRAISER_STATUSES, FUNDRAISER_TYPES, cleanMultiline, cleanText, everestSummary, fundraiserTotal, isClosed, isHttpsUrl,
  isJustGivingUrl, isRefreshDue, isTakingDares, isVoterId, justGivingShortName, looksLikeLeaderKey, makeCode, makeLeaderKey,
  parseOptionalPounds, parsePounds, parseWinnerCount, percentOf, poundsToPence, rankBoard, slugify, uniqueSlug,
} from './logic.js';

const SITE_NAME = 'Sponsor University of Plymouth';
const EVEREST_INTERVAL_MS = 15 * 60 * 1000;
// Each page is one outbound request, and the free plan allows 50 per visit.
const EVEREST_MAX_PAGES = 40;

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

// The owner signs in with ADMIN_PASSWORD. Leaders sign in with a key from the
// admins table, which can do everything except manage logins.
async function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'The admin password has not been set up yet.');
  const hash = await ipHash(request, env);
  if ((await recentCount(env, 'login-fail', hash, 900)) >= 10) {
    throw new HttpError(429, 'Too many wrong passwords. Wait 15 minutes and try again.');
  }
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const given = await sha256(token);
  const expected = await sha256(env.ADMIN_PASSWORD);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= given[i] ^ expected[i];
  if (difference === 0) return { id: null, name: 'Owner', role: 'owner' };
  if (looksLikeLeaderKey(token)) {
    const leader = await env.DB.prepare('SELECT id, name, role FROM admins WHERE key_hash = ? AND revoked = 0').bind(toHex(given)).first();
    if (leader) return leader;
  }
  await recordEvent(env, 'login-fail', hash);
  throw new HttpError(401, 'That password or key is wrong.');
}

// For public pages that show a draft to a signed-in leader. No header means no attempt.
async function optionalAdmin(request, env) {
  if (!request.headers.get('authorization')) return null;
  try {
    return await requireAdmin(request, env);
  } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
}

function requireOwner(admin) {
  if (admin.role !== 'owner') throw new HttpError(403, 'Only the owner can manage logins.');
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

function requireMultiline(input, maxLength, tooLongMessage) {
  const text = cleanMultiline(input, maxLength);
  if (text === null) throw new HttpError(400, tooLongMessage);
  return text;
}

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(results.map((row) => [row.key, row.value]));
}

const setSetting = (env, key, value) =>
  env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value);

/* Everest total, read from JustGiving */

async function fetchJustGivingPage(env, shortName) {
  try {
    const response = await fetch(`https://api.justgiving.com/${env.JUSTGIVING_APP_ID}/v1/fundraising/pages/${encodeURIComponent(shortName)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { ok: false, status: response.status };
    const page = await response.json();
    const raised = poundsToPence(page.grandTotalRaisedExcludingGiftAid);
    if (raised === null) return { ok: false, status: response.status };
    return {
      ok: true,
      raised_pence: raised,
      target_pence: poundsToPence(page.fundraisingTarget) ?? 0,
      owner: cleanText(page.owner, 80) ?? '',
    };
  } catch {
    // Timeouts and network errors. The address holds the AppID, so nothing is logged.
    return { ok: false, status: 0 };
  }
}

const EVEREST_COLUMNS = 'short_name, owner, raised_pence, target_pence, fetched_at, failed';

const listEverestPages = async (env) =>
  (await env.DB.prepare(`SELECT ${EVEREST_COLUMNS} FROM everest_pages ORDER BY rowid`).all()).results;

// Reads every page at once and saves the lot in one batch. A page that fails
// keeps its last figures and is only marked as failed.
async function refreshEverest(env, pages) {
  const now = Date.now();
  const batch = pages.slice(0, EVEREST_MAX_PAGES);
  const results = await Promise.all(batch.map((page) => fetchJustGivingPage(env, page.short_name)));
  const save = env.DB.prepare('UPDATE everest_pages SET owner = ?, raised_pence = ?, target_pence = ?, fetched_at = ?, failed = 0 WHERE short_name = ?');
  const fail = env.DB.prepare('UPDATE everest_pages SET failed = 1 WHERE short_name = ?');
  const statements = results.map((result, index) => (result.ok
    ? save.bind(result.owner, result.raised_pence, result.target_pence, now, batch[index].short_name)
    : fail.bind(batch[index].short_name)));
  // If JustGiving was unreachable altogether, try again in a minute instead of in 15.
  const retrySoon = results.length > 0 && results.every((result) => !result.ok);
  statements.push(setSetting(env, 'everest_checked_at', String(retrySoon ? now - EVEREST_INTERVAL_MS + 60000 : now)));
  await env.DB.batch(statements);
  return pages.map((page, index) => {
    const result = results[index];
    if (!result) return page;
    return result.ok
      ? { ...page, owner: result.owner, raised_pence: result.raised_pence, target_pence: result.target_pence, fetched_at: now, failed: 0 }
      : { ...page, failed: 1 };
  });
}

// Cached figures, refreshed at most every 15 minutes. Visitors get the cached
// figures straight away and the refresh runs after the response, unless there
// are no figures at all yet.
async function getEverest(env, ctx, settings) {
  let pages = await listEverestPages(env);
  const now = Date.now();
  if (env.JUSTGIVING_APP_ID && pages.length > 0 && isRefreshDue(settings.everest_checked_at, now, EVEREST_INTERVAL_MS)) {
    // Only the request that moves the timestamp does the refresh.
    const claim = await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'everest_checked_at' AND CAST(value AS INTEGER) <= ?")
      .bind(String(now), now - EVEREST_INTERVAL_MS).run();
    if (claim.meta.changes) {
      const job = refreshEverest(env, pages);
      if (everestSummary(pages)) ctx.waitUntil(job.catch(() => {}));
      else pages = await job;
    }
  }
  const summary = everestSummary(pages);
  return summary && { ...summary, percent: percentOf(summary.raised_pence, summary.target_pence) };
}

/* Fundraisers */

const FUNDRAISER_COLUMNS = 'id, slug, title, type, summary, body, photo_url, target_pence, event_date, place, donate_url, manual_total_pence, status, sort, closes_at, group_enabled, group_winners, walker_winners';

const findFundraiser = (env, column, value) =>
  env.DB.prepare(`SELECT ${FUNDRAISER_COLUMNS} FROM fundraisers WHERE ${column} = ?`).bind(value).first();

// Confirmed money and the number of dares on the list, per dare board. This
// matches what the board itself shows: hidden walkers and a switched-off group
// board are left out.
async function dareStats(env) {
  const { results } = await env.DB.prepare(`
    SELECT t.fundraiser_id AS id, COUNT(DISTINCT d.id) AS dares,
      COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.amount_pence END), 0) AS pence
    FROM targets t
      JOIN fundraisers f ON f.id = t.fundraiser_id
      JOIN dares d ON d.target_id = t.id AND d.status = 'approved'
      LEFT JOIN pledges p ON p.dare_id = d.id
    WHERE t.active = 1 AND (t.kind != 'group' OR f.group_enabled = 1)
    GROUP BY t.fundraiser_id`).all();
  return new Map(results.map((row) => [row.id, row]));
}

function publicCard(fundraiser, stats) {
  const dare = stats.get(fundraiser.id) ?? { pence: 0, dares: 0 };
  const total = fundraiserTotal(fundraiser, dare.pence);
  const card = {
    slug: fundraiser.slug,
    title: fundraiser.title,
    type: fundraiser.type,
    summary: fundraiser.summary,
    photo_url: fundraiser.photo_url,
    event_date: fundraiser.event_date,
    place: fundraiser.place,
    status: fundraiser.status,
    total_pence: total,
    target_pence: fundraiser.target_pence,
    percent: percentOf(total, fundraiser.target_pence),
  };
  if (fundraiser.type === 'dare') {
    card.dares = dare.dares;
    card.closed = !isTakingDares(fundraiser);
  }
  return card;
}

const PAGE_KEYS = { about: 'about_text', 'our-challenge': 'challenge_text' };

async function getSite(env, ctx, pageKey) {
  const settings = await getSettings(env);
  const [{ results: fundraisers }, stats, everest] = await Promise.all([
    env.DB.prepare(`SELECT ${FUNDRAISER_COLUMNS} FROM fundraisers WHERE status != 'draft' ORDER BY sort, id`).all(),
    dareStats(env),
    getEverest(env, ctx, settings),
  ]);
  const live = fundraisers.filter((f) => f.status === 'live');
  const featured = live.find((f) => f.id === Number(settings.featured_fundraiser_id)) ?? live[0] ?? null;
  const site = {
    intro: settings.site_intro ?? '',
    everest,
    featured: featured?.slug ?? null,
    fundraisers: fundraisers.map((f) => publicCard(f, stats)),
  };
  if (pageKey) {
    if (!PAGE_KEYS[pageKey]) throw new HttpError(404, 'Not found.');
    site.page = { body: settings[PAGE_KEYS[pageKey]] ?? '' };
  }
  return site;
}

// Drafts exist only for signed-in leaders. To everyone else they are not found.
async function findVisibleFundraiser(request, env, slug) {
  const fundraiser = slug ? await findFundraiser(env, 'slug', slug) : null;
  if (!fundraiser) throw new HttpError(404, 'That fundraiser could not be found.');
  if (fundraiser.status === 'draft' && !(await optionalAdmin(request, env))) {
    throw new HttpError(404, 'That fundraiser could not be found.');
  }
  return fundraiser;
}

async function getFundraiser(request, env, slug) {
  const fundraiser = await findVisibleFundraiser(request, env, slug);
  const stats = await dareStats(env);
  return {
    fundraiser: { ...publicCard(fundraiser, stats), body: fundraiser.body, donate_url: fundraiser.type === 'dare' ? '' : fundraiser.donate_url },
    preview: fundraiser.status === 'draft',
  };
}

// With no slug this is the first dare board, which is what /api/board meant before there were several.
async function getBoard(request, env, slug) {
  const fundraiser = await findVisibleFundraiser(request, env, slug ?? (await findFundraiser(env, 'id', 1))?.slug);
  if (fundraiser.type !== 'dare') throw new HttpError(404, 'That fundraiser has no dare board.');
  const [{ results: targets }, { results: dares }] = await Promise.all([
    env.DB.prepare('SELECT id, slug, name, kind, jg_url FROM targets WHERE fundraiser_id = ? AND active = 1 ORDER BY sort, id').bind(fundraiser.id).all(),
    env.DB.prepare(`
      SELECT d.id, d.code, d.target_id, d.title, d.detail, d.suggested_by,
        COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.amount_pence END), 0) AS total_pence,
        COALESCE(SUM(CASE WHEN p.status = 'unconfirmed' THEN p.amount_pence END), 0) AS pending_pence,
        (SELECT COUNT(*) FROM votes v WHERE v.dare_id = d.id) AS votes
      FROM dares d JOIN targets t ON t.id = d.target_id LEFT JOIN pledges p ON p.dare_id = d.id
      WHERE d.status = 'approved' AND t.fundraiser_id = ?
      GROUP BY d.id`).bind(fundraiser.id).all(),
  ]);
  const boards = targets.filter((target) => fundraiser.group_enabled || target.kind !== 'group').map((target) => {
    const isGroup = target.kind === 'group';
    const winnerCount = isGroup ? fundraiser.group_winners : fundraiser.walker_winners;
    const own = dares.filter((dare) => dare.target_id === target.id);
    return { ...target, winnerCount, ...rankBoard(own, winnerCount, isGroup ? 'votes' : 'total_pence') };
  });
  const total = boards.reduce((sum, board) => sum + board.dares.reduce((s, dare) => s + dare.total_pence, 0), 0);
  return {
    fundraiser: {
      slug: fundraiser.slug,
      title: fundraiser.title,
      summary: fundraiser.summary,
      body: fundraiser.body,
      photo_url: fundraiser.photo_url,
      event_date: fundraiser.event_date,
      place: fundraiser.place,
      status: fundraiser.status,
      closes_at: fundraiser.closes_at,
      target_pence: fundraiser.target_pence,
      percent: percentOf(total, fundraiser.target_pence),
    },
    preview: fundraiser.status === 'draft',
    closed: !isTakingDares(fundraiser),
    total_pence: total,
    boards,
  };
}

const GROUP_NO_MONEY = 'Group dares are free to vote on, so they do not take donations.';
const LIST_CLOSED = 'The dare list has closed.';

// A dare that is on a list, with the fundraiser settings that decide what can be done to it.
const findListedDare = (env, code) =>
  env.DB.prepare(`
    SELECT d.id, t.kind, t.active, f.type, f.status, f.closes_at, f.group_enabled
    FROM dares d JOIN targets t ON t.id = d.target_id JOIN fundraisers f ON f.id = t.fundraiser_id
    WHERE d.code = ? AND d.status = 'approved'`).bind(code).first();

async function findPublicDare(env, code) {
  const dare = await findListedDare(env, code);
  // Drafts and hidden walkers are not on the public site, so neither are their dares.
  if (!dare || dare.status === 'draft' || !dare.active) throw new HttpError(404, 'That dare is no longer on the list.');
  return dare;
}

async function createDare(request, env) {
  const body = await readBody(request);
  if (body.website) return json({ ok: true }, 201); // Honeypot: only bots fill this in.
  const title = requireText(body.title, 80, 'Keep the dare to 80 characters.');
  if (title.length < 3) throw new HttpError(400, 'Describe the dare in a few words.');
  const detail = requireText(body.detail, 240, 'Keep the details to 240 characters.');
  const suggestedBy = requireText(body.suggested_by, 40, 'Keep your name to 40 characters.');
  const target = await env.DB.prepare(`
    SELECT t.id, t.kind, f.type, f.status, f.closes_at, f.group_enabled
    FROM targets t JOIN fundraisers f ON f.id = t.fundraiser_id
    WHERE t.id = ? AND t.active = 1 AND f.status != 'draft'`).bind(Number(body.target_id) || 0).first();
  if (!target) throw new HttpError(400, 'Choose who the dare is for.');
  if (!isTakingDares(target)) throw new HttpError(403, LIST_CLOSED);
  if (target.kind === 'group' && !target.group_enabled) throw new HttpError(400, 'Group dares are switched off.');
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
  const amount = parsePounds(body.amount);
  if (amount === null) throw new HttpError(400, 'Enter the amount in pounds, like 10 or 7.50.');
  const donorName = requireText(body.donor_name, 60, 'Keep the name to 60 characters.');
  const dare = await findPublicDare(env, String(body.code ?? ''));
  if (!isTakingDares(dare)) throw new HttpError(403, LIST_CLOSED);
  if (dare.kind === 'group') throw new HttpError(400, GROUP_NO_MONEY);
  await enforceLimit(request, env, 'pledge', 40, 3600);
  await env.DB.prepare('INSERT INTO pledges (dare_id, amount_pence, donor_name) VALUES (?, ?, ?)')
    .bind(dare.id, amount, donorName).run();
  return json({ ok: true }, 201);
}

// Voting again on the same dare takes the vote back, so a mistaken tap can be undone.
async function toggleVote(request, env) {
  const body = await readBody(request);
  if (!isVoterId(body.voter)) throw new HttpError(400, 'Your vote could not be read. Refresh the page and try again.');
  const dare = await findPublicDare(env, String(body.code ?? ''));
  if (dare.kind !== 'group') throw new HttpError(404, 'That dare is no longer on the list.');
  if (!isTakingDares(dare)) throw new HttpError(403, LIST_CLOSED);
  if (!dare.group_enabled) throw new HttpError(400, 'Group dares are switched off.');
  // Generous because campus Wi-Fi and halls can put many people behind one address.
  await enforceLimit(request, env, 'vote', 300, 3600);
  const added = await env.DB.prepare('INSERT OR IGNORE INTO votes (dare_id, voter) VALUES (?, ?)').bind(dare.id, body.voter).run();
  if (!added.meta.changes) {
    await env.DB.prepare('DELETE FROM votes WHERE dare_id = ? AND voter = ?').bind(dare.id, body.voter).run();
  }
  return json({ voted: Boolean(added.meta.changes) });
}

/* Admin */

async function adminOverview(env, admin) {
  const [settings, fundraisers, stats, dares, pledges, everestPages] = await Promise.all([
    getSettings(env),
    env.DB.prepare(`SELECT ${FUNDRAISER_COLUMNS} FROM fundraisers ORDER BY sort, id`).all(),
    dareStats(env),
    env.DB.prepare(`
      SELECT d.id, d.title, d.detail, d.suggested_by, d.created_at, t.name AS target_name, t.kind AS target_kind,
        f.id AS fundraiser_id, f.title AS fundraiser_title
      FROM dares d JOIN targets t ON t.id = d.target_id JOIN fundraisers f ON f.id = t.fundraiser_id
      WHERE d.status = 'pending' ORDER BY d.created_at`).all(),
    env.DB.prepare(`
      SELECT p.id, p.amount_pence, p.donor_name, p.created_at, d.code, d.title, t.name AS target_name, t.jg_url,
        f.id AS fundraiser_id, f.title AS fundraiser_title
      FROM pledges p JOIN dares d ON d.id = p.dare_id JOIN targets t ON t.id = d.target_id JOIN fundraisers f ON f.id = t.fundraiser_id
      WHERE p.status = 'unconfirmed' ORDER BY p.created_at`).all(),
    listEverestPages(env),
  ]);
  const summary = everestSummary(everestPages);
  return {
    me: { name: admin.name, role: admin.role },
    fundraisers: fundraisers.results.map((f) => {
      const dare = stats.get(f.id) ?? { pence: 0, dares: 0 };
      const total = fundraiserTotal(f, dare.pence);
      return { ...f, total_pence: total, percent: percentOf(total, f.target_pence), dares: dare.dares };
    }),
    featured_id: Number(settings.featured_fundraiser_id) || null,
    queue: { dares: dares.results, pledges: pledges.results },
    everest: {
      pages: everestPages,
      summary: summary && { ...summary, percent: percentOf(summary.raised_pence, summary.target_pence) },
      has_key: Boolean(env.JUSTGIVING_APP_ID),
    },
    site: {
      site_intro: settings.site_intro ?? '',
      about_text: settings.about_text ?? '',
      challenge_text: settings.challenge_text ?? '',
    },
  };
}

async function adminFundraiser(env, id) {
  const fundraiser = await findFundraiser(env, 'id', id);
  if (!fundraiser) throw new HttpError(404, 'That fundraiser no longer exists.');
  if (fundraiser.type !== 'dare') return { fundraiser, targets: [], dares: [] };
  const [targets, dares] = await Promise.all([
    env.DB.prepare('SELECT id, slug, name, kind, jg_url, active FROM targets WHERE fundraiser_id = ? ORDER BY sort, id').bind(id).all(),
    env.DB.prepare(`
      SELECT d.id, d.code, d.title, d.reviewed_by, t.name AS target_name, t.kind AS target_kind,
        COALESCE((SELECT SUM(p.amount_pence) FROM pledges p WHERE p.dare_id = d.id AND p.status = 'confirmed'), 0) AS total_pence,
        (SELECT COUNT(*) FROM votes v WHERE v.dare_id = d.id) AS votes
      FROM dares d JOIN targets t ON t.id = d.target_id
      WHERE d.status = 'approved' AND t.fundraiser_id = ? ORDER BY t.sort, t.id, d.id`).bind(id).all(),
  ]);
  return { fundraiser, targets: targets.results, dares: dares.results };
}

function readFundraiserFields(body, type) {
  const title = requireText(body.title, 60, 'Keep the title to 60 characters.');
  if (title.length < 3) throw new HttpError(400, 'Give the fundraiser a title.');
  const photoUrl = String(body.photo_url ?? '').trim();
  if (photoUrl && (photoUrl.length > 500 || !isHttpsUrl(photoUrl))) {
    throw new HttpError(400, 'The photo link must start with https:// and point at an image.');
  }
  const target = parseOptionalPounds(body.target);
  if (target === null) throw new HttpError(400, 'Enter the target in pounds, like 500, or leave it blank.');
  if (!FUNDRAISER_STATUSES.includes(body.status)) throw new HttpError(400, 'Choose draft, live or finished.');
  const fields = {
    title,
    type,
    summary: requireText(body.summary, 200, 'Keep the short description to 200 characters.'),
    body: requireMultiline(body.body, 4000, 'Keep the longer description to 4,000 characters.'),
    photo_url: photoUrl,
    target_pence: target,
    event_date: requireText(body.event_date, 60, 'Keep the date to 60 characters.'),
    place: requireText(body.place, 80, 'Keep the place to 80 characters.'),
    status: body.status,
  };
  if (type === 'dare') {
    const groupWinners = parseWinnerCount(body.group_winners);
    const walkerWinners = parseWinnerCount(body.walker_winners);
    if (groupWinners === null || walkerWinners === null) throw new HttpError(400, 'Winner counts must be between 1 and 10.');
    const closesAt = String(body.closes_at ?? '').trim();
    if (closesAt && !Number.isFinite(Date.parse(closesAt))) throw new HttpError(400, 'That closing time is not a valid date.');
    return { ...fields, closes_at: closesAt, group_winners: groupWinners, walker_winners: walkerWinners, group_enabled: ['on', '1', 1, true].includes(body.group_enabled) ? 1 : 0 };
  }
  const donateUrl = String(body.donate_url ?? '').trim();
  if (donateUrl && !isJustGivingUrl(donateUrl)) throw new HttpError(400, 'The donation link must be an https://www.justgiving.com address.');
  const total = parseOptionalPounds(body.manual_total);
  if (total === null) throw new HttpError(400, 'Enter the total raised in pounds, like 52.39, or leave it blank.');
  return { ...fields, donate_url: donateUrl, manual_total_pence: total };
}

function requireType(input) {
  if (!FUNDRAISER_TYPES.includes(input)) throw new HttpError(400, 'Choose what kind of fundraiser this is.');
  return input;
}

async function adminCreateFundraiser(request, env) {
  const body = await readBody(request);
  const fields = readFundraiserFields(body, requireType(body.type));
  const [fundraiserSlugs, targetRows] = await Promise.all([
    env.DB.prepare('SELECT slug FROM fundraisers').all(),
    env.DB.prepare('SELECT slug FROM targets').all(),
  ]);
  fields.slug = uniqueSlug(slugify(fields.title, 'fundraiser'), new Set(fundraiserSlugs.results.map((row) => row.slug)));
  const columns = Object.keys(fields);
  const created = await env.DB.prepare(
    `INSERT INTO fundraisers (${columns.join(', ')}, sort) VALUES (${columns.map(() => '?').join(', ')}, (SELECT COALESCE(MAX(sort), 0) + 1 FROM fundraisers))`,
  ).bind(...columns.map((column) => fields[column])).run();
  const id = created.meta.last_row_id;

  if (fields.type === 'dare') {
    // Every dare board gets its own group list. Target slugs are unique across the whole site.
    const taken = new Set(targetRows.results.map((row) => row.slug));
    const insert = env.DB.prepare('INSERT INTO targets (slug, name, kind, jg_url, active, sort, fundraiser_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const statements = [insert.bind(uniqueSlug(`${fields.slug}-group`, taken), 'The whole group', 'group', '', 1, 0, id)];
    const copyFrom = Number(body.copy_walkers_from) || 0;
    if (copyFrom) {
      const { results: walkers } = await env.DB.prepare("SELECT name, jg_url, active FROM targets WHERE fundraiser_id = ? AND kind = 'walker' ORDER BY sort, id").bind(copyFrom).all();
      walkers.forEach((walker, index) => {
        statements.push(insert.bind(uniqueSlug(slugify(walker.name), taken), walker.name, 'walker', walker.jg_url, walker.active, index + 1, id));
      });
    }
    await env.DB.batch(statements);
  }
  return json({ ok: true, id, slug: fields.slug }, 201);
}

async function adminUpdateFundraiser(request, env, id) {
  const body = await readBody(request);
  const existing = await findFundraiser(env, 'id', id);
  if (!existing) throw new HttpError(404, 'That fundraiser no longer exists.');
  // A dare board owns walkers, dares and donations, so it can't turn into something else or back.
  let type = existing.type;
  if (type !== 'dare' && body.type !== undefined) {
    type = requireType(body.type);
    if (type === 'dare') throw new HttpError(400, 'An event or challenge cannot be turned into a dare board. Make a new fundraiser instead.');
  }
  const fields = readFundraiserFields(body, type);
  const columns = Object.keys(fields);
  await env.DB.prepare(`UPDATE fundraisers SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`)
    .bind(...columns.map((column) => fields[column]), id).run();
  return json({ ok: true });
}

async function adminReorderFundraisers(request, env) {
  const { ids } = await readBody(request);
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((id) => Number.isInteger(id) && id > 0)) {
    throw new HttpError(400, 'That order could not be read.');
  }
  const statement = env.DB.prepare('UPDATE fundraisers SET sort = ? WHERE id = ?');
  await env.DB.batch(ids.map((id, index) => statement.bind(index + 1, id)));
  return json({ ok: true });
}

async function adminSetFeatured(request, env) {
  const { id } = await readBody(request);
  const fundraiser = await findFundraiser(env, 'id', Number(id) || 0);
  if (!fundraiser) throw new HttpError(404, 'That fundraiser no longer exists.');
  if (fundraiser.status !== 'live') throw new HttpError(400, 'Only a live fundraiser can be featured.');
  await setSetting(env, 'featured_fundraiser_id', String(fundraiser.id)).run();
  return json({ ok: true });
}

const SITE_TEXT = {
  site_intro: [300, 'Keep the homepage intro to 300 characters.'],
  about_text: [6000, 'Keep the About page to 6,000 characters.'],
  challenge_text: [6000, 'Keep the Our Challenge page to 6,000 characters.'],
};

async function adminUpdateSite(request, env) {
  const body = await readBody(request);
  const statements = [];
  for (const [key, [maxLength, message]] of Object.entries(SITE_TEXT)) {
    if (body[key] === undefined) continue;
    const text = key === 'site_intro' ? requireText(body[key], maxLength, message) : requireMultiline(body[key], maxLength, message);
    statements.push(setSetting(env, key, text));
  }
  if (statements.length === 0) throw new HttpError(400, 'There was nothing to save.');
  await env.DB.batch(statements);
  return json({ ok: true });
}

async function adminAddEverestPage(request, env) {
  const body = await readBody(request);
  const shortName = justGivingShortName(body.url);
  if (!shortName) throw new HttpError(400, 'Paste the link to a JustGiving page, like https://www.justgiving.com/fundraising/your-page.');
  const pages = await listEverestPages(env);
  if (pages.some((page) => page.short_name.toLowerCase() === shortName.toLowerCase())) throw new HttpError(400, 'That page is already on the list.');
  if (pages.length >= EVEREST_MAX_PAGES) throw new HttpError(400, `The list can hold ${EVEREST_MAX_PAGES} pages at most.`);
  // Reading the page now proves the link is right and fills in its figures.
  let page = { owner: '', raised_pence: null, target_pence: null };
  if (env.JUSTGIVING_APP_ID) {
    page = await fetchJustGivingPage(env, shortName);
    if (!page.ok && page.status === 404) throw new HttpError(400, 'JustGiving has no page at that link. Check it and try again.');
    if (!page.ok) throw new HttpError(502, 'JustGiving did not answer. Try again in a minute.');
  }
  await env.DB.prepare('INSERT INTO everest_pages (short_name, owner, raised_pence, target_pence, fetched_at) VALUES (?, ?, ?, ?, ?)')
    .bind(shortName, page.owner, page.raised_pence, page.target_pence, page.raised_pence === null ? null : Date.now()).run();
  return json({ ok: true }, 201);
}

async function adminRemoveEverestPage(env, shortName) {
  const { meta } = await env.DB.prepare('DELETE FROM everest_pages WHERE short_name = ?').bind(shortName).run();
  if (!meta.changes) throw new HttpError(404, 'That page is no longer on the list.');
  return json({ ok: true });
}

async function adminRefreshEverest(env) {
  if (!env.JUSTGIVING_APP_ID) throw new HttpError(503, 'The JustGiving key has not been set up yet.');
  const pages = await refreshEverest(env, await listEverestPages(env));
  return json({ ok: true, failed: pages.filter((page) => page.failed).length });
}

async function adminListLogins(env) {
  const { results } = await env.DB.prepare('SELECT id, name, role, created_at, revoked FROM admins ORDER BY revoked, id').all();
  return json({ logins: results });
}

// The key is returned once and only its hash is kept, so it can't be shown again.
async function adminCreateLogin(request, env) {
  const body = await readBody(request);
  const name = requireText(body.name, 40, 'Keep the name to 40 characters.');
  if (!name) throw new HttpError(400, 'Enter the leader\'s name.');
  const key = makeLeaderKey(crypto.getRandomValues(new Uint8Array(40)));
  await env.DB.prepare("INSERT INTO admins (name, role, key_hash) VALUES (?, 'leader', ?)").bind(name, toHex(await sha256(key))).run();
  return json({ ok: true, name, key }, 201);
}

async function adminRevokeLogin(env, id) {
  const { meta } = await env.DB.prepare('UPDATE admins SET revoked = 1 WHERE id = ?').bind(id).run();
  if (!meta.changes) throw new HttpError(404, 'That login no longer exists.');
  return json({ ok: true });
}

async function setStatus(request, env, admin, table, id, allowed) {
  const { status } = await readBody(request);
  if (!allowed.includes(status)) throw new HttpError(400, 'That status is not allowed.');
  const { meta } = await env.DB.prepare(`UPDATE ${table} SET status = ?, reviewed_by = ? WHERE id = ?`).bind(status, admin.name, id).run();
  if (!meta.changes) throw new HttpError(404, 'That item no longer exists.');
  return json({ ok: true });
}

// Leaders can add a donation after the list has closed, because JustGiving donations can arrive late.
async function adminAddPledge(request, env, admin) {
  const body = await readBody(request);
  const amount = parsePounds(body.amount);
  if (amount === null) throw new HttpError(400, 'Enter the amount in pounds, like 10 or 7.50.');
  const donorName = requireText(body.donor_name, 60, 'Keep the name to 60 characters.');
  const code = String(body.code ?? '').trim().toUpperCase();
  const dare = await findListedDare(env, code);
  if (!dare) throw new HttpError(404, `No live dare has the code ${code || '(blank)'}.`);
  if (dare.kind === 'group') throw new HttpError(400, GROUP_NO_MONEY);
  await env.DB.prepare("INSERT INTO pledges (dare_id, amount_pence, donor_name, source, status, reviewed_by) VALUES (?, ?, ?, 'admin', 'confirmed', ?)")
    .bind(dare.id, amount, donorName, admin.name).run();
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
  const body = await readBody(request);
  const { name, jgUrl } = readTargetFields(body);
  // Without a fundraiser the walker joins the first dare board, as it did before there were several.
  const fundraiser = await findFundraiser(env, 'id', Number(body.fundraiser_id) || 1);
  if (!fundraiser || fundraiser.type !== 'dare') throw new HttpError(400, 'Walkers can only be added to a dare board.');
  const { results } = await env.DB.prepare('SELECT slug FROM targets').all();
  const slug = uniqueSlug(slugify(name), new Set(results.map((row) => row.slug)));
  await env.DB.prepare("INSERT INTO targets (slug, name, kind, jg_url, fundraiser_id, sort) VALUES (?, ?, 'walker', ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM targets WHERE fundraiser_id = ?))")
    .bind(slug, name, jgUrl, fundraiser.id, fundraiser.id).run();
  return json({ ok: true }, 201);
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

async function routeAdmin(request, env, path, method) {
  const admin = await requireAdmin(request, env);
  const is = (m, p) => method === m && path === `/api/admin/${p}`;

  if (is('GET', 'overview')) return json(await adminOverview(env, admin));
  if (is('POST', 'fundraisers')) return adminCreateFundraiser(request, env);
  if (is('PUT', 'fundraisers/order')) return adminReorderFundraisers(request, env);
  if (is('PUT', 'featured')) return adminSetFeatured(request, env);
  if (is('PUT', 'site')) return adminUpdateSite(request, env);
  if (is('POST', 'pledges')) return adminAddPledge(request, env, admin);
  if (is('POST', 'walkers')) return adminAddWalker(request, env);
  if (is('POST', 'everest/pages')) return adminAddEverestPage(request, env);
  if (is('POST', 'everest/refresh')) return adminRefreshEverest(env);

  const everestPage = /^\/api\/admin\/everest\/pages\/([A-Za-z0-9_-]{1,100})$/.exec(path);
  if (everestPage && method === 'DELETE') return adminRemoveEverestPage(env, everestPage[1]);

  if (path === '/api/admin/logins' || path.startsWith('/api/admin/logins/')) {
    requireOwner(admin);
    if (is('GET', 'logins')) return adminListLogins(env);
    if (is('POST', 'logins')) return adminCreateLogin(request, env);
    const login = /^\/api\/admin\/logins\/(\d+)$/.exec(path);
    if (login && method === 'PUT') return adminRevokeLogin(env, Number(login[1]));
  }

  const match = /^\/api\/admin\/(fundraisers|dares|pledges|targets)\/(\d+)$/.exec(path);
  if (match) {
    const id = Number(match[2]);
    if (match[1] === 'fundraisers' && method === 'GET') return json(await adminFundraiser(env, id));
    if (method === 'PUT') {
      if (match[1] === 'fundraisers') return adminUpdateFundraiser(request, env, id);
      if (match[1] === 'dares') return setStatus(request, env, admin, 'dares', id, ['approved', 'rejected']);
      if (match[1] === 'pledges') return setStatus(request, env, admin, 'pledges', id, ['confirmed', 'rejected']);
      return adminUpdateTarget(request, env, id);
    }
  }
  throw new HttpError(404, 'Not found.');
}

async function route(request, env, ctx, url) {
  const { pathname: path } = url;
  const { method } = request;

  if (method === 'GET' && path === '/api/site') return json(await getSite(env, ctx, url.searchParams.get('page')));
  if (method === 'GET' && path === '/api/board') return json(await getBoard(request, env, url.searchParams.get('f')));
  if (method === 'GET' && path.startsWith('/api/fundraisers/')) return json(await getFundraiser(request, env, path.slice('/api/fundraisers/'.length)));
  if (method === 'POST' && path === '/api/dares') return createDare(request, env);
  if (method === 'POST' && path === '/api/pledges') return createPledge(request, env);
  if (method === 'POST' && path === '/api/votes') return toggleVote(request, env);
  if (path.startsWith('/api/admin/')) return routeAdmin(request, env, path, method);
  throw new HttpError(404, 'Not found.');
}

/* Fundraiser pages: /f/<slug> */

const setContent = (value) => ({ element(element) { element.setAttribute('content', value); } });

// Serves the dare board or the event page for a fundraiser, with its own title
// and description filled in so that shared links preview properly.
async function servePage(request, env, url) {
  const asset = (path, status) => env.ASSETS.fetch(new Request(new URL(path, url))).then((response) => {
    const headers = new Headers(response.headers);
    headers.delete('etag');
    headers.set('cache-control', 'no-cache');
    return new Response(response.body, { status, headers });
  });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });

  const slug = /^\/f\/([a-z0-9-]{1,60})\/?$/.exec(url.pathname)?.[1];
  const fundraiser = slug ? await findFundraiser(env, 'slug', slug) : null;
  if (!fundraiser) return asset('/404', 404);

  const response = await asset(fundraiser.type === 'dare' ? '/board' : '/fundraiser', 200);
  // Drafts get the plain shell. The page asks the API for the draft with the leader's own login.
  if (fundraiser.status === 'draft') {
    response.headers.set('x-robots-tag', 'noindex');
    return response;
  }
  if (typeof HTMLRewriter === 'undefined') return response;
  const title = `${fundraiser.title} | ${SITE_NAME}`;
  const description = fundraiser.summary || `A fundraiser by University of Plymouth students for Amnesty International.`;
  let rewriter = new HTMLRewriter()
    .on('title', { element(element) { element.setInnerContent(title); } })
    .on('#title', { element(element) { element.setInnerContent(fundraiser.title); } })
    .on('#lede', { element(element) { element.setInnerContent(fundraiser.summary); } })
    .on('meta[name="description"]', setContent(description))
    .on('meta[property="og:title"]', setContent(fundraiser.title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[property="og:url"]', setContent(`${url.origin}/f/${fundraiser.slug}`));
  if (fundraiser.photo_url) rewriter = rewriter.on('meta[property="og:image"]', setContent(fundraiser.photo_url));
  return rewriter.transform(response);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/f/')) return await servePage(request, env, url);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      return await route(request, env, ctx, url);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: 'Something went wrong on the server. Try again.' }, 500);
    }
  },
};
