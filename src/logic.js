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

// Trims, collapses whitespace and strips control characters.
export function cleanText(input, maxLength) {
  const text = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
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

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'walker';
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
