// A dare board: suggest, vote, donate with a code, and a list per walker.
import { $, el, leaderHeaders, money, renderProse, route } from './site.js';

const slug = location.pathname.split('/').filter(Boolean)[1] ?? '';
const boardPath = `/api/board?f=${encodeURIComponent(slug)}`;

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? 'That did not go through. Try again.');
  return data;
}

let board = null;
let walkerSlug = null;
// Set once a draft has been opened with a leader's login, so later refreshes keep working.
let authHeaders = {};
const highlightCode = new URLSearchParams(location.search).get('dare');

const groupBoard = () => board.boards.find((b) => b.kind === 'group');
const walkerBoards = () => board.boards.filter((b) => b.kind === 'walker');
const currentWalker = () => walkerBoards().find((b) => b.slug === walkerSlug) ?? walkerBoards()[0];

function cutLabel(target) {
  const n = target.winnerCount;
  const who = target.kind === 'group' ? 'we do' : `${target.name} does`;
  return n === 1 ? `Above this line, ${who} it` : `Above this line, ${who} them. Top ${n} win.`;
}

function darePendingText(pence) {
  return `+${money(pence)} being checked`;
}

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked storage only means votes are forgotten on refresh.
  }
}

function loadVotedCodes() {
  try {
    return new Set(JSON.parse(readStored('voted') ?? '[]'));
  } catch {
    return new Set();
  }
}

const voterId = readStored('voter') ?? crypto.randomUUID();
writeStored('voter', voterId);
const votedCodes = loadVotedCodes();

function voteButton(dare) {
  const voted = votedCodes.has(dare.code);
  const button = el('button', voted ? 'button button-quiet' : 'button', voted ? 'Voted' : 'Vote');
  button.type = 'button';
  button.setAttribute('aria-pressed', String(voted));
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await post('/api/votes', { code: dare.code, voter: voterId });
      if (result.voted) votedCodes.add(dare.code);
      else votedCodes.delete(dare.code);
      writeStored('voted', JSON.stringify([...votedCodes]));
      await load();
    } catch (error) {
      button.disabled = false;
      $('group-status').textContent = error.message;
      $('group-status').hidden = false;
    }
  });
  return button;
}

function renderDare(dare, rank, target, winning) {
  const li = el('li', `dare${winning ? ' dare-winning' : ''}`);
  li.id = dare.code;
  if (dare.code === highlightCode) li.classList.add('dare-highlight');

  li.append(el('span', 'dare-rank', String(rank)));

  const body = el('div', 'dare-body');
  body.append(el('p', 'dare-title', dare.title));
  if (dare.detail) body.append(el('p', 'dare-detail', dare.detail));
  if (dare.suggested_by) body.append(el('p', 'dare-by', `Suggested by ${dare.suggested_by}`));
  li.append(body);

  const isGroup = target.kind === 'group';
  const score = el('div', 'dare-money');
  if (isGroup) {
    score.append(el('p', 'dare-total', String(dare.votes)), el('p', 'dare-pending', dare.votes === 1 ? 'vote' : 'votes'));
  } else {
    score.append(el('p', 'dare-total', money(dare.total_pence)));
    if (dare.pending_pence > 0) score.append(el('p', 'dare-pending', darePendingText(dare.pending_pence)));
  }
  li.append(score);

  const actions = el('div', 'dare-actions');
  if (!board.closed && isGroup) {
    actions.append(voteButton(dare));
  } else if (!board.closed) {
    const back = el('button', 'button', target.jg_url ? 'Donate to this dare' : 'Donation link coming soon');
    back.type = 'button';
    back.disabled = !target.jg_url;
    back.addEventListener('click', () => openDonate(dare, target));
    actions.append(back);
  }
  const share = el('button', 'button button-quiet', 'Copy link');
  share.type = 'button';
  share.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?dare=${encodeURIComponent(dare.code)}`;
    share.textContent = (await copy(url)) ? 'Link copied' : url;
  });
  actions.append(share);
  li.append(actions);
  return li;
}

function renderList(target, list, status) {
  const rows = [];
  target.dares.forEach((dare, index) => {
    if (index === target.winners) rows.push(el('li', 'cut', cutLabel(target)));
    rows.push(renderDare(dare, index + 1, target, index < target.winners));
  });
  if (target.dares.length > 0 && target.winners === target.dares.length) rows.push(el('li', 'cut', cutLabel(target)));
  list.replaceChildren(...rows);

  status.hidden = target.dares.length > 0;
  status.textContent = board.closed
    ? 'No dares made the list.'
    : `No dares here yet. Suggest the first one for ${target.kind === 'group' ? 'the group' : target.name}.`;
}

function renderBoards() {
  const group = groupBoard();
  $('group-section').hidden = !group;
  if (group) {
    renderList(group, $('group-dares'), $('group-status'));
    $('group-suggest').hidden = board.closed;
  }

  const walker = currentWalker();
  $('walker-section').hidden = !walker;
  if (!walker) return;
  walkerSlug = walker.slug;

  $('tabs').replaceChildren(...walkerBoards().map((b) => {
    const tab = el('button', 'tab', b.name);
    tab.type = 'button';
    tab.setAttribute('aria-pressed', String(b.slug === walkerSlug));
    tab.addEventListener('click', () => {
      walkerSlug = b.slug;
      history.replaceState(null, '', `#${b.slug}`);
      renderBoards();
    });
    return tab;
  }));

  renderList(walker, $('walker-dares'), $('walker-status'));
  $('walker-suggest').textContent = `Suggest a dare for ${walker.name}`;
  $('walker-suggest').hidden = board.closed;
}

function renderPage() {
  const { fundraiser, closed, total_pence: total } = board;

  $('title').textContent = fundraiser.title;
  $('lede').textContent = fundraiser.summary;
  document.title = `${fundraiser.title} | Sponsor University of Plymouth`;
  $('preview-note').hidden = !board.preview;

  const meta = [];
  if (fundraiser.event_date) meta.push(`The walk: ${fundraiser.event_date}.`);
  if (fundraiser.closes_at && !closed) {
    const when = new Date(fundraiser.closes_at).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'Europe/London' });
    meta.push(`The list closes ${when}.`);
  }
  $('cover-meta').textContent = meta.join(' ');
  $('cover-meta').hidden = meta.length === 0;

  const group = groupBoard();
  const leader = group?.winners ? group.dares[0] : null;
  $('cover-now').hidden = !leader;
  if (leader) {
    $('cover-now-dare').textContent = leader.title;
    if (closed) $('cover-now').querySelector('.cover-now-label').textContent = 'The top dare is';
  }

  const hasTarget = fundraiser.target_pence > 0;
  $('raised').hidden = total === 0 && !hasTarget;
  $('raised').replaceChildren(el('strong', '', money(total)),
    hasTarget ? ` of ${money(fundraiser.target_pence)} raised through dares so far for Amnesty International.` : ' raised through dares so far for Amnesty International.');
  $('progress').hidden = !hasTarget;
  if (hasTarget && !$('progress').firstChild) $('progress').append(route(fundraiser.percent));
  else if (hasTarget) $('progress').firstChild.style.setProperty('--done', String(Math.min(fundraiser.percent, 100) / 100));

  $('closed-note').hidden = !closed;
  $('about-section').hidden = !fundraiser.body;
  renderProse($('about-section'), fundraiser.body);

  const select = $('suggest-target');
  select.replaceChildren(...board.boards.map((b) => {
    const option = el('option', '', b.name);
    option.value = b.id;
    return option;
  }));

  renderBoards();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

let donating = null;

function openDonate(dare, target) {
  donating = dare;
  $('donate-dare').textContent = dare.title;
  $('donate-code').textContent = dare.code;
  $('donate-link').href = target.jg_url;
  $('copy-code').textContent = 'Copy code';
  $('pledge-form').reset();
  $('pledge-error').hidden = true;
  $('donate-flow').hidden = false;
  $('donate-done').hidden = true;
  $('donate-dialog').showModal();
}

$('copy-code').addEventListener('click', async () => {
  const copied = await copy(donating.code);
  $('copy-code').textContent = copied ? 'Copied' : 'Select the code above';
});

function wireForm(form, errorEl, onSubmit) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type=submit]');
    errorEl.hidden = true;
    submit.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(form)));
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

wireForm($('pledge-form'), $('pledge-error'), async (fields) => {
  await post('/api/pledges', { ...fields, code: donating.code });
  $('donate-flow').hidden = true;
  $('donate-done').hidden = false;
  await load();
});

wireForm($('suggest-form'), $('suggest-error'), async (fields) => {
  await post('/api/dares', fields);
  $('suggest-form').hidden = true;
  $('suggest-done').hidden = false;
});

function openSuggest(target) {
  $('suggest-form').reset();
  $('suggest-target').value = target.id;
  $('suggest-error').hidden = true;
  $('suggest-form').hidden = false;
  $('suggest-done').hidden = true;
  $('suggest-dialog').showModal();
}

$('group-suggest').addEventListener('click', () => openSuggest(groupBoard()));
$('walker-suggest').addEventListener('click', () => openSuggest(currentWalker()));

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) {
      dialog.close();
      return;
    }
    // A click on the dialog element itself is either its padding or the backdrop.
    const box = dialog.getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (event.target === dialog && outside) dialog.close();
  });
}

// Drafts are only served to signed-in leaders, so a miss is retried once with their login.
async function fetchBoard() {
  let response = await fetch(boardPath, { headers: authHeaders });
  if (response.status === 404 && !authHeaders.authorization && leaderHeaders().authorization) {
    authHeaders = leaderHeaders();
    response = await fetch(boardPath, { headers: authHeaders });
  }
  if (!response.ok) {
    const error = new Error('board request failed');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function load() {
  board = await fetchBoard();
  renderPage();
}

function pickInitialWalker() {
  const owner = highlightCode && walkerBoards().find((b) => b.dares.some((d) => d.code === highlightCode));
  if (owner) walkerSlug = owner.slug;
  else if (location.hash.length > 1) walkerSlug = location.hash.slice(1);
}

load().then(() => {
  pickInitialWalker();
  renderBoards();
  if (highlightCode) document.getElementById(highlightCode)?.scrollIntoView({ block: 'center' });
  else if (walkerBoards().some((b) => `#${b.slug}` === location.hash)) $('walker-section').scrollIntoView();
}).catch((error) => {
  if (error.status === 404) $('title').textContent = "That fundraiser isn't on the map";
  $('group-status').textContent = error.status === 404
    ? 'The link may be old, or the fundraiser may have been taken down.'
    : 'The dares could not be loaded. Refresh the page to try again.';
});
