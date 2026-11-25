// Pure helpers, kept free of Worker APIs so they can run under node --test.

const CODE_ALPHABET = '23456789BCDFGHJKMNPQRTVWXZ';

export function makeCode(randomBytes) {
  let out = '';
  for (const byte of randomBytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `DARE-${out}`;
}

// Parses "5", "5.5" or "12.50", with an optional leading pound sign, into pence.
// Returns null for anything else, including zero and implausibly large amounts.
export function parsePounds(input) {
  const match = /^£?\s*(\d{1,5})(?:\.(\d{1,2}))?$/.exec(String(input ?? '').trim());
  if (!match) return null;
  const pence = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return pence > 0 ? pence : null;
}

// Whole pounds or pounds and pence, up to £9,999,999.99. Blank and zero both mean
// "none", so targets and typed-in totals can be left empty. Returns null for junk.
export function parseOptionalPounds(input) {
  const text = String(input ?? '').trim().replace(/,/g, '');
  if (text === '') return 0;
  const match = /^£?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

// JustGiving sends amounts as strings like "252.39". Returns pence, or null if unreadable.
export function poundsToPence(input) {
  if (input === null || input === undefined || input === '') return null;
  const pounds = Number(input);
  return Number.isFinite(pounds) && pounds >= 0 ? Math.round(pounds * 100) : null;
}

// Trims, collapses whitespace and strips control characters.
export function cleanText(input, maxLength) {
  const text = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? null : text;
}

// Like cleanText but keeps line breaks, for descriptions and page text.
// Paragraphs end up separated by one blank line at most.
export function cleanMultiline(input, maxLength) {
  const text = String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > maxLength ? null : text;
}

export function isJustGivingUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && /^(www\.)?justgiving\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function isHttpsUrl(input) {
  try {
    return new URL(input).protocol === 'https:';
  } catch {
    return false;
  }
}

// Accepts a JustGiving page link (/fundraising/name or /page/name) or the bare
// short name, and returns the short name the API wants. Null for anything else.
export function justGivingShortName(input) {
  const text = String(input ?? '').trim();
  let name = text;
  if (/^https?:/i.test(text)) {
    if (!isJustGivingUrl(text)) return null;
    const match = /^\/(?:fundraising|page)\/([^/]+)\/?$/.exec(new URL(text).pathname);
    if (!match) return null;
    name = match[1];
  }
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name) ? name : null;
}

export function slugify(name, fallback = 'walker', maxLength = 40) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, maxLength).replace(/^-+|-+$/g, '');
  return slug || fallback;
}

// The first of base, base-2, base-3 and so on that isn't in the taken set. Adds it to the set.
export function uniqueSlug(base, taken) {
  let slug = base;
  for (let suffix = 2; taken.has(slug); suffix++) slug = `${base}-${suffix}`;
  taken.add(slug);
  return slug;
}

// Highest score first: confirmed pence for walkers, votes for the group. Ties go
// to the dare suggested earliest, which has the lower id. A score of 0 can't win.
export function rankBoard(dares, winnerCount, score = 'total_pence') {
  const ranked = [...dares].sort((a, b) => b[score] - a[score] || a.id - b.id);
  const winners = ranked.slice(0, winnerCount).filter((dare) => dare[score] > 0).length;
  return { dares: ranked, winners };
}

export function isVoterId(input) {
  return typeof input === 'string' && /^[a-zA-Z0-9-]{16,64}$/.test(input);
}

export function isClosed(closesAt, now = Date.now()) {
  const closes = Date.parse(closesAt);
  return Number.isFinite(closes) && now >= closes;
}

export function parseWinnerCount(input) {
  const count = Number(input);
  return Number.isInteger(count) && count >= 1 && count <= 10 ? count : null;
}

export const FUNDRAISER_TYPES = ['dare', 'event', 'challenge'];
export const FUNDRAISER_STATUSES = ['draft', 'live', 'finished'];

// Dare boards count their confirmed dare donations. Everything else shows the
// figure a leader typed in.
export function fundraiserTotal(fundraiser, darePence = 0) {
  return fundraiser.type === 'dare' ? darePence : fundraiser.manual_total_pence;
}

// Whole percent of the target, rounded down so 99.9% never reads as done.
// Null when no target is set.
export function percentOf(totalPence, targetPence) {
  if (!(targetPence > 0)) return null;
  return Math.max(0, Math.floor((totalPence / targetPence) * 100));
}

// A dare board takes suggestions, votes and donations only while it is live and before it closes.
export function isTakingDares(fundraiser, now = Date.now()) {
  return fundraiser.type === 'dare' && fundraiser.status === 'live' && !isClosed(fundraiser.closes_at, now);
}

// Adds up the JustGiving pages that have been read at least once. Null when none
// have, so the site can leave the numbers out instead of showing zero.
export function everestSummary(pages) {
  const read = pages.filter((page) => page.raised_pence !== null && page.raised_pence !== undefined);
  if (read.length === 0) return null;
  return {
    raised_pence: read.reduce((sum, page) => sum + page.raised_pence, 0),
    target_pence: read.reduce((sum, page) => sum + (page.target_pence ?? 0), 0),
    pages: read.length,
    updated_at: Math.max(...read.map((page) => page.fetched_at ?? 0)),
  };
}

export function isRefreshDue(checkedAt, now, intervalMs) {
  const last = Number(checkedAt);
  return !Number.isFinite(last) || now - last >= intervalMs;
}

const KEY_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

// A leader key: 40 characters from an alphabet of 31, about 198 bits.
export function makeLeaderKey(randomBytes) {
  let out = '';
  for (const byte of randomBytes) out += KEY_ALPHABET[byte % KEY_ALPHABET.length];
  return `leader-${out}`;
}

export const looksLikeLeaderKey = (input) => typeof input === 'string' && /^leader-[2-9a-hjkmnp-z]{40}$/.test(input);
