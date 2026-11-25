// The challenge leaders' page. One page, with the views switched by the address hash:
// #todo, #fundraisers, #f/<id>, #new, #site and #logins.

const STORAGE_KEY = 'admin-password';
const SVG_NS = 'http://www.w3.org/2000/svg';
const TYPE_LABELS = { dare: 'Group Dare', event: 'Event', challenge: 'Challenge' };
const STATUS_LABELS = { live: 'Live', draft: 'Draft', finished: 'Finished' };
const SAVED_NOTES = {
  draft: 'Saved. It is still a draft, so only leaders can see it.',
  live: 'Saved. It is live on the site.',
  finished: 'Saved. It is listed as finished.',
};

const $ = (id) => document.getElementById(id);

const state = {
  overview: null,
  loadedAt: 0,
  tab: 'live',
  receipt: null,
  flash: '',
};
let password = '';
let currentHash = null;
let viewToken = 0;
let isDirty = () => false;
let uid = 0;

/* Small helpers */

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key in node) node[key] = value;
    else if (value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// £90 for whole pounds, £252.39 otherwise.
function money(pence) {
  const total = Math.round(Number(pence) || 0);
  const pounds = Math.floor(total / 100).toLocaleString('en-GB');
  const rest = total % 100;
  return rest ? `£${pounds}.${String(rest).padStart(2, '0')}` : `£${pounds}`;
}

// Pence to the text of a pounds field. Nothing set is a blank field, not 0.
function poundsField(pence) {
  const total = Math.round(Number(pence) || 0);
  if (total <= 0) return '';
  const rest = total % 100;
  return rest ? `${Math.floor(total / 100)}.${String(rest).padStart(2, '0')}` : String(total / 100);
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// "For the whole group", not "For The whole group".
const midSentence = (name) => name.replace(/^The /, 'the ');

function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function day(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Converts between a stored UTC time and the browser's local datetime-local format.
function toLocalInput(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

function announce(text) {
  const node = $('announce');
  node.textContent = '';
  setTimeout(() => { node.textContent = text; }, 60);
}

function readStored() {
  for (const pick of [() => sessionStorage, () => localStorage]) {
    try {
      const value = pick().getItem(STORAGE_KEY);
      if (value) return value;
    } catch {
      // Private windows can block storage. The sign-in then lasts until refresh.
    }
  }
  return '';
}

function store(value, remember) {
  try {
    (remember ? localStorage : sessionStorage).setItem(STORAGE_KEY, value);
  } catch {
    // Staying signed in across refreshes is only a convenience.
  }
  try {
    (remember ? sessionStorage : localStorage).removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage is blocked.
  }
}

function forget() {
  for (const pick of [() => sessionStorage, () => localStorage]) {
    try {
      pick().removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clean up if storage is blocked.
    }
  }
}

async function api(method, path, body) {
  let response;
  try {
    response = await fetch(`/api/admin/${path}`, {
      method,
      headers: { authorization: `Bearer ${password}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('The site could not be reached. Check your connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error ?? 'That did not go through. Try again.');
    error.status = response.status;
    // A key that has been revoked, or a changed password, ends the session.
    if (response.status === 401 && state.overview) signOut('Your password or key no longer works. Sign in again.');
    throw error;
  }
  return data;
}

function showError(node, error) {
  node.textContent = error.message;
  node.hidden = false;
}

const errorLine = () => h('p', { class: 'form-error', role: 'alert', hidden: true });
const statusLine = () => h('p', { class: 'status-line', role: 'status' });

function setStatus(node, text) {
  node.replaceChildren(...(text ? [icon('tick'), h('span', { text })] : []));
}

// Runs one action for a button. The button stays focusable while it works, so
// keyboard and screen-reader users keep their place, and any error lands in errorNode.
async function act(button, errorNode, task, busyText) {
  if (button.getAttribute('aria-disabled') === 'true') return;
  if (errorNode) errorNode.hidden = true;
  const label = button.textContent;
  button.setAttribute('aria-disabled', 'true');
  if (busyText) button.textContent = busyText;
  try {
    await task();
  } catch (error) {
    if (errorNode && errorNode.isConnected) showError(errorNode, error);
    else if ($('sign-in').hidden) announce(error.message);
  } finally {
    button.removeAttribute('aria-disabled');
    if (busyText) button.textContent = label;
  }
}

function button(label, { quiet = false, type = 'button', className = '' } = {}) {
  return h('button', { class: `button${quiet ? ' button-quiet' : ''}${className ? ` ${className}` : ''}`, type, text: label });
}

function field(label, control, { hint, className } = {}) {
  if (!control.id) control.id = `c${++uid}`;
  const wrap = h('div', { class: `field${className ? ` ${className}` : ''}` }, h('label', { htmlFor: control.id, text: label }), control);
  if (hint) {
    const hintNode = h('p', { class: 'hint', id: `${control.id}-hint`, text: hint });
    control.setAttribute('aria-describedby', hintNode.id);
    wrap.append(hintNode);
  }
  return wrap;
}

// A "142 of 200" count under a text field. It warns instead of cutting text off.
function addCounter(wrap, control, max) {
  const counter = h('p', { class: 'counter', id: `${control.id}-count` });
  const update = () => {
    const length = control.value.trim().length;
    counter.textContent = `${length} of ${max}`;
    counter.classList.toggle('counter-over', length > max);
  };
  control.addEventListener('input', update);
  control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), counter.id].filter(Boolean).join(' '));
  const hintNode = wrap.querySelector('.hint');
  const foot = h('div', { class: 'field-foot' });
  if (hintNode) foot.append(hintNode);
  else foot.append(h('span'));
  foot.append(counter);
  wrap.append(foot);
  update();
  return update;
}

function select(options, value, attrs = {}) {
  const node = h('select', attrs, options.map(([optionValue, label]) => h('option', { value: String(optionValue), text: label })));
  node.value = String(value);
  return node;
}

// Progress drawn as a walked route, the same as on the public site.
function route(total, target) {
  const fraction = target > 0 ? Math.max(0, Math.min(1, total / target)) : 0;
  const node = h('div', { class: `route${target > 0 && total >= target ? ' route-reached' : ''}`, 'aria-hidden': 'true' }, h('span', { class: 'route-done' }));
  node.style.setProperty('--done', String(fraction));
  return node;
}

function outLink(label, href, { sameSite = false, className = 'text-link' } = {}) {
  // Our own pages open with rel=opener so a sign-in kept for this tab only carries
  // over and drafts can be previewed. Other sites never get a handle on this page.
  return h('a', { class: className, href, target: '_blank', rel: sameSite ? 'opener' : 'noopener noreferrer' },
    h('span', { text: label }), icon('out'), h('span', { class: 'visually-hidden', text: ' (opens in a new tab)' }));
}

/* Signing in and out */

function showSignIn(message, focus = true) {
  $('loading').hidden = true;
  $('view').hidden = true;
  $('view').replaceChildren();
  $('nav').hidden = true;
  $('me').hidden = true;
  $('sign-out').hidden = true;
  document.body.classList.remove('signed-in');
  $('sign-in').hidden = false;
  $('login-error').hidden = !message;
  $('login-error').textContent = message ?? '';
  document.title = 'Sign in | Challenge leaders';
  if (focus) $('password').focus();
}

function signOut(message) {
  password = '';
  forget();
  state.overview = null;
  state.receipt = null;
  state.flash = '';
  isDirty = () => false;
  viewToken++;
  $('login-form').reset();
  showSignIn(message);
  if (!message) announce('You are signed out.');
}

function applyOverview(data) {
  state.overview = data;
  state.loadedAt = Date.now();
  $('me-name').textContent = data.me.name;
  $('nav-logins').hidden = data.me.role !== 'owner';
  const waiting = data.queue.dares.length + data.queue.pledges.length;
  $('todo-count').replaceChildren(String(waiting), h('span', { class: 'visually-hidden', text: ' waiting' }));
  $('todo-count').hidden = waiting === 0;
}

async function reload() {
  applyOverview(await api('GET', 'overview'));
  return state.overview;
}

async function enter() {
  await reload();
  $('loading').hidden = true;
  $('sign-in').hidden = true;
  $('nav').hidden = false;
  $('me').hidden = false;
  $('sign-out').hidden = false;
  $('view').hidden = false;
  document.body.classList.add('signed-in');
  await show();
}

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  act($('login-button'), null, async () => {
    $('login-error').hidden = true;
    password = $('password').value.trim();
    try {
      await enter();
      store(password, $('remember').checked);
      $('password').value = '';
    } catch (error) {
      password = '';
      if (error.status === 401) forget();
      showSignIn(error.message);
    }
  }, 'Signing in…');
});

$('sign-out').addEventListener('click', () => {
  if (isDirty() && !confirm('You have changes you have not saved. Sign out without saving?')) return;
  signOut();
});

/* Views */

function parseRoute() {
  const hash = location.hash.slice(1);
  const edit = /^f\/(\d+)$/.exec(hash);
  if (edit) return { view: 'edit', id: Number(edit[1]), nav: 'fundraisers' };
  if (hash === 'new') return { view: 'new', nav: 'fundraisers' };
  if (hash === 'fundraisers' || hash === 'site') return { view: hash, nav: hash };
  if (hash === 'logins' && state.overview.me.role === 'owner') return { view: 'logins', nav: 'logins' };
  return { view: 'todo', nav: 'todo' };
}

function mount(root, title, { focus = true } = {}) {
  $('view').replaceChildren(root);
  document.title = `${title} | Challenge leaders`;
  if (!focus) return;
  window.scrollTo(0, 0);
  root.querySelector('h1')?.focus({ preventScroll: true });
}

const pageHeading = (text) => h('h1', { tabIndex: -1, text });

async function show(options) {
  const target = parseRoute();
  currentHash = location.hash;
  isDirty = () => false;
  const token = ++viewToken;
  for (const link of document.querySelectorAll('#nav a')) {
    if (link.dataset.view === target.nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (target.view !== 'todo') state.receipt = null;
  if (target.view === 'todo') renderTodo(options);
  else if (target.view === 'fundraisers') renderFundraisers(options);
  else if (target.view === 'site') renderSite(options);
  else if (target.view === 'logins') await renderLogins(token, options);
  else await renderEdit(target.view === 'new' ? null : target.id, token, options);
}

window.addEventListener('hashchange', () => {
  if (!state.overview || location.hash === currentHash) return;
  if (isDirty() && !confirm('You have changes you have not saved. Leave without saving?')) {
    history.replaceState(null, '', currentHash || '#todo');
    return;
  }
  show();
});

window.addEventListener('beforeunload', (event) => {
  if (state.overview && isDirty()) event.preventDefault();
});

// Coming back to the tab after a while picks up anything new in the queue.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.overview || Date.now() - state.loadedAt < 60000) return;
  const before = JSON.stringify(state.overview.queue);
  try {
    await reload();
  } catch {
    return;
  }
  if (parseRoute().view === 'todo' && JSON.stringify(state.overview.queue) !== before && !$('view').contains(document.activeElement)) {
    renderTodo({ focus: false });
  }
});

/* To do */

function tile(label, figure, note, extra) {
  return h('div', { class: 'tile' }, h('p', { class: 'tile-label', text: label }), h('p', { class: 'tile-figure', text: figure }),
    extra, h('p', { class: 'tile-note', text: note }));
}

function tiles(overview) {
  const dares = overview.queue.dares.length;
  const pledges = overview.queue.pledges.length;
  const parts = [dares && `${plural(dares, 'dare')} to read`, pledges && `${plural(pledges, 'donation')} to check`].filter(Boolean);
  const waiting = tile('Waiting for you', String(dares + pledges), parts.length ? parts.join(' and ') : 'Nothing needs you right now');
  if (dares + pledges > 0) waiting.classList.add('tile-waiting');

  const summary = overview.everest.summary;
  let everest;
  if (summary) {
    const note = summary.target_pence > 0
      ? `of ${money(summary.target_pence)}, read from ${plural(summary.pages, 'JustGiving page')}`
      : `Read from ${plural(summary.pages, 'JustGiving page')}`;
    everest = tile('Everest total', money(summary.raised_pence), note, summary.target_pence > 0 && route(summary.raised_pence, summary.target_pence));
  } else {
    everest = tile('Everest total', '–', overview.everest.has_key ? 'Not read from JustGiving yet' : 'The JustGiving key is not set up yet');
  }

  const counted = overview.fundraisers.filter((f) => f.status !== 'draft');
  const raised = counted.reduce((sum, f) => sum + f.total_pence, 0);
  const site = tile('Raised through this site', money(raised), 'Across live and finished fundraisers');
  return h('div', { class: 'tiles' }, waiting, everest, site);
}

function receiptWords({ kind, entry, status }) {
  if (kind === 'dare') {
    return status === 'approved'
      ? [`"${entry.title}" is on the list.`, 'Take it off again', 'rejected']
      : [`"${entry.title}" was turned down.`, 'Put it on the list instead', 'approved'];
  }
  const what = `${money(entry.amount_pence)} for "${entry.title}"`;
  return status === 'confirmed'
    ? [`${what} is confirmed.`, 'Mark it as not found instead', 'rejected']
    : [`${what} is marked as not found.`, 'Confirm it instead', 'confirmed'];
}

// Saves a decision, then leaves a receipt where the item was, with a way to change it.
async function decide(kind, entry, status, index) {
  await api('PUT', `${kind === 'dare' ? 'dares' : 'pledges'}/${entry.id}`, { status });
  state.receipt = { kind, entry, status, index };
  await reload();
  renderTodo({ focus: false });
  $('receipt')?.focus();
  announce(receiptWords(state.receipt)[0]);
}

function receiptNode() {
  if (!state.receipt) return null;
  const [text, undoLabel, undoStatus] = receiptWords(state.receipt);
  const error = errorLine();
  const undo = h('button', { class: 'link-button', type: 'button', text: undoLabel });
  const { kind, entry, index } = state.receipt;
  undo.addEventListener('click', () => act(undo, error, () => decide(kind, entry, undoStatus, index)));
  return h('li', { class: 'receipt', id: 'receipt', tabIndex: -1 }, h('p', { class: 'receipt-text', text }), undo, error);
}

function queueItem(kind, entry, index) {
  const error = errorLine();
  const yes = button(kind === 'dare' ? 'Put on the list' : 'Confirm');
  const no = button(kind === 'dare' ? 'Turn down' : "Can't find it", { quiet: true });
  const choose = (pressed, other, status, busyText) => pressed.addEventListener('click', () => {
    if (other.getAttribute('aria-disabled') === 'true') return;
    act(pressed, error, () => decide(kind, entry, status, index), busyText);
  });
  choose(yes, no, kind === 'dare' ? 'approved' : 'confirmed', 'Saving…');
  choose(no, yes, 'rejected', 'Saving…');

  const node = h('li', { class: 'item' }, h('p', { class: 'item-where', text: entry.fundraiser_title }));
  if (kind === 'dare') {
    const from = entry.suggested_by ? `Suggested by ${entry.suggested_by}` : 'No name given';
    node.append(
      h('h3', { class: 'item-title', text: entry.title }),
      entry.detail && h('p', { class: 'item-detail', text: entry.detail }),
      h('p', { class: 'item-meta', text: `For ${midSentence(entry.target_name)}. ${from}, ${when(entry.created_at)}.` }),
    );
  } else {
    const facts = h('dl', { class: 'facts' },
      h('dt', { text: 'Dare code' }), h('dd', {}, h('span', { class: 'code', text: entry.code })),
      h('dt', { text: 'Whose page' }), h('dd', { text: entry.target_name }),
      h('dt', { text: 'Name given' }), h('dd', { text: entry.donor_name || 'None' }),
      h('dt', { text: 'Logged' }), h('dd', { text: when(entry.created_at) }));
    node.append(h('h3', { class: 'item-title', text: `${money(entry.amount_pence)} for "${entry.title}"` }), facts);
    if (entry.jg_url) node.append(outLink(`Open ${entry.target_name}'s JustGiving page`, entry.jg_url));
    else node.append(h('p', { class: 'warn', text: `${entry.target_name} has no JustGiving link yet. Add one under Fundraisers.` }));
  }
  node.append(error, h('div', { class: 'actions' }, yes, no));
  return node;
}

function renderTodo(options) {
  const overview = state.overview;
  const { dares, pledges } = overview.queue;
  const page = h('div', { class: 'page' }, pageHeading('To do'), tiles(overview));

  // A list stays on screen while it still holds the receipt for the last thing done in it.
  const sections = [
    ['dare', dares, 'dares-h', 'Dares to read', 'A dare only shows on the site once you put it on the list.'],
    ['pledge', pledges, 'pledges-h', 'Donations to check', 'Open the JustGiving page and look for a donation with this code and amount. Only confirmed donations move a dare up.'],
  ].filter(([kind, entries]) => entries.length > 0 || state.receipt?.kind === kind);

  if (sections.length) {
    const queue = h('div', { class: `queue ${sections.length === 2 ? 'queue-two' : 'queue-one'}` });
    for (const [kind, entries, id, heading, note] of sections) {
      const nodes = entries.map((entry, index) => queueItem(kind, entry, index));
      if (state.receipt?.kind === kind) nodes.splice(Math.min(state.receipt.index, nodes.length), 0, receiptNode());
      queue.append(h('section', { class: 'section', 'aria-labelledby': id },
        h('h2', { id, text: heading }),
        h('p', { class: 'section-note', text: note }),
        h('ul', { class: 'stack' }, nodes)));
    }
    page.append(queue);
  }
  if (dares.length + pledges.length === 0) {
    page.append(h('div', { class: 'empty' },
      h('h2', {}, icon('tick'), h('span', { text: 'Nothing is waiting' })),
      h('p', { text: 'When someone suggests a dare or says they have donated, it shows up here for you to check.' })));
  }
  mount(page, 'To do', options);
}

/* Fundraisers */

function progress(fundraiser) {
  if (fundraiser.target_pence > 0) {
    return [
      h('div', { class: 'tally' },
        h('p', { class: 'tally-money' }, h('strong', { text: money(fundraiser.total_pence) }), `of ${money(fundraiser.target_pence)}`),
        h('p', { class: 'tally-percent', text: `${fundraiser.percent}%` })),
      route(fundraiser.total_pence, fundraiser.target_pence),
    ];
  }
  return [
    h('div', { class: 'tally' }, h('p', { class: 'tally-money' }, h('strong', { text: money(fundraiser.total_pence) }), 'raised')),
    h('p', { class: 'no-target', text: 'No target set' }),
  ];
}

function renderFundraisers(options) {
  const page = h('div', { class: 'page' });
  const add = h('a', { class: 'button', href: '#new' }, icon('plus'), h('span', { text: 'New fundraiser' }));
  page.append(h('div', { class: 'page-top' }, pageHeading('Fundraisers'), add));

  // Featured picker
  const live = state.overview.fundraisers.filter((f) => f.status === 'live');
  const featured = h('section', { class: 'panel section', 'aria-labelledby': 'featured-h' }, h('h2', { id: 'featured-h', text: 'On the homepage' }));
  if (live.length === 0) {
    featured.append(h('p', { class: 'section-note', text: 'Nothing is live yet. Once a fundraiser is live you can choose it as the big card on the homepage.' }));
  } else {
    const chosen = live.some((f) => f.id === state.overview.featured_id) ? state.overview.featured_id : live[0].id;
    const picker = select(live.map((f) => [f.id, f.title]), chosen, { id: 'featured' });
    const error = errorLine();
    const status = statusLine();
    let saved = String(chosen);
    picker.addEventListener('change', async () => {
      error.hidden = true;
      setStatus(status, '');
      const id = Number(picker.value);
      try {
        await api('PUT', 'featured', { id });
        saved = picker.value;
        state.overview.featured_id = id;
        const text = `Saved. ${picker.selectedOptions[0].textContent} is now the big card on the homepage.`;
        setStatus(status, text);
      } catch (failure) {
        picker.value = saved;
        showError(error, failure);
      }
    });
    featured.append(
      field('Featured fundraiser', picker, { hint: 'This is the big card at the top of the homepage. Only live fundraisers can go here. It saves as soon as you choose.' }),
      error, status);
  }
  page.append(featured);

  // Live, drafts and finished
  const pills = h('div', { class: 'pills', role: 'group', 'aria-label': 'Which fundraisers to show' });
  const listError = errorLine();
  const listNote = h('p', { class: 'hint' });
  const list = h('ol', { class: 'stack' });
  const section = h('section', { class: 'section', 'aria-labelledby': 'list-h' },
    h('h2', { id: 'list-h', text: 'All fundraisers' }), pills, listNote, listError, list);
  page.append(section);

  const emptyNotes = {
    live: 'Nothing is live. Open a draft and set it to Live to put it on the site.',
    draft: 'No drafts. Start one with "New fundraiser".',
    finished: 'Nothing has finished yet.',
  };

  async function move(fundraiser, direction) {
    const shown = state.overview.fundraisers.filter((f) => f.status === state.tab);
    const other = shown[shown.findIndex((f) => f.id === fundraiser.id) + direction];
    if (!other) return;
    const ids = state.overview.fundraisers.map((f) => f.id);
    const a = ids.indexOf(fundraiser.id);
    const b = ids.indexOf(other.id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    await api('PUT', 'fundraisers/order', { ids });
    await reload();
    renderList();
    const place = state.overview.fundraisers.filter((f) => f.status === state.tab).findIndex((f) => f.id === fundraiser.id) + 1;
    const again = list.querySelector(`[data-move="${fundraiser.id}:${direction}"]`);
    (again && !again.disabled ? again : list.querySelector(`[data-move="${fundraiser.id}:${-direction}"]`))?.focus();
    announce(`${fundraiser.title} moved ${direction < 0 ? 'up' : 'down'}. It is now number ${place} of ${shown.length}.`);
  }

  function card(fundraiser, index, count) {
    const main = h('div', { class: 'fcard-main' },
      h('p', { class: 'fcard-type', text: TYPE_LABELS[fundraiser.type] }),
      h('h3', { class: 'fcard-title', text: fundraiser.title }),
      fundraiser.type === 'dare' && h('p', { class: 'fcard-fact', text: `${plural(fundraiser.dares, 'dare')} on the list` }));
    const actions = h('div', { class: 'fcard-actions' },
      h('a', { class: 'button', href: `#f/${fundraiser.id}` }, h('span', { text: 'Edit' }), h('span', { class: 'visually-hidden', text: ` ${fundraiser.title}` })),
      outLink(fundraiser.status === 'draft' ? 'Preview' : 'View on site', `/f/${fundraiser.slug}`, { sameSite: true, className: 'button button-quiet' }));
    const node = h('li', { class: 'fcard' }, main, h('div', { class: 'fcard-money' }, progress(fundraiser)), actions);
    if (count > 1) {
      const arrow = (direction, name, label) => {
        const control = h('button', { class: 'button button-quiet button-square', type: 'button', 'aria-label': `Move ${fundraiser.title} ${label}`, 'data-move': `${fundraiser.id}:${direction}` }, icon(name));
        control.disabled = direction < 0 ? index === 0 : index === count - 1;
        control.addEventListener('click', () => act(control, listError, () => move(fundraiser, direction)));
        return control;
      };
      node.append(h('div', { class: 'fcard-move' }, arrow(-1, 'up', 'up'), arrow(1, 'down', 'down')));
    }
    return node;
  }

  function renderList() {
    const all = state.overview.fundraisers;
    pills.replaceChildren(...['live', 'draft', 'finished'].map((status) => {
      const count = all.filter((f) => f.status === status).length;
      const pill = h('button', { class: 'pill', type: 'button', 'aria-pressed': String(state.tab === status), 'data-tab': status,
        text: `${status === 'draft' ? 'Drafts' : STATUS_LABELS[status]} (${count})` });
      pill.addEventListener('click', () => {
        state.tab = status;
        listError.hidden = true;
        renderList();
        pills.querySelector(`[data-tab="${status}"]`).focus();
      });
      return pill;
    }));
    const shown = all.filter((f) => f.status === state.tab);
    listNote.textContent = shown.length > 1 ? 'The arrows change the order they appear in on the site.' : '';
    listNote.hidden = shown.length < 2;
    if (shown.length === 0) list.replaceChildren(h('li', { class: 'empty-small', text: emptyNotes[state.tab] }));
    else list.replaceChildren(...shown.map((f, index) => card(f, index, shown.length)));
  }

  renderList();
  mount(page, 'Fundraisers', options);
}

/* Editing a fundraiser */

function notFound(message) {
  return h('div', { class: 'page page-narrow' },
    h('a', { class: 'text-link back', href: '#fundraisers' }, icon('back'), h('span', { text: 'All fundraisers' })),
    pageHeading('That fundraiser is not here'),
    h('p', { class: 'lede', text: message }));
}

async function renderEdit(id, token, options) {
  const isNew = id === null;
  let detail = { fundraiser: { type: 'event', status: 'draft', group_enabled: 1, group_winners: 3, walker_winners: 1 }, targets: [], dares: [] };
  if (!isNew) {
    $('view').replaceChildren(h('p', { class: 'load-note', text: 'Loading…' }));
    try {
      detail = await api('GET', `fundraisers/${id}`);
    } catch (error) {
      if (token === viewToken && state.overview) mount(notFound(error.message), 'Fundraiser', options);
      return;
    }
    if (token !== viewToken) return;
  }
  let fundraiser = detail.fundraiser;
  const isDareBoard = !isNew && fundraiser.type === 'dare';

  const page = h('div', { class: 'page page-narrow' });
  const heading = pageHeading(isNew ? 'New fundraiser' : fundraiser.title);
  const chip = h('span', { class: 'chip' });
  const viewLink = isNew ? null : outLink('', `/f/${fundraiser.slug}`, { sameSite: true });
  const flash = statusLine();
  setStatus(flash, state.flash);
  state.flash = '';
  page.append(
    h('a', { class: 'text-link back', href: '#fundraisers' }, icon('back'), h('span', { text: 'All fundraisers' })),
    heading,
    isNew
      ? h('p', { class: 'lede', text: 'Fill in what you know. It starts as a draft that only leaders can see, and you can come back and change anything.' })
      : h('div', { class: 'edit-meta' }, chip, viewLink),
    flash);

  function updateHead() {
    if (isNew) return;
    heading.textContent = fundraiser.title;
    chip.textContent = STATUS_LABELS[fundraiser.status];
    chip.className = `chip chip-${fundraiser.status}`;
    viewLink.firstChild.textContent = fundraiser.status === 'draft' ? 'Preview' : 'View on site';
    document.title = `${fundraiser.title} | Challenge leaders`;
  }

  // The details form
  const form = h('form', { id: 'details', noValidate: false });
  const title = h('input', { name: 'title', required: true, minLength: 3, maxLength: 60, autocomplete: 'off' });

  let typeOptions = Object.entries(TYPE_LABELS);
  let typeHint = 'A Group Dare has a list of dares people can vote for and donate to. Events and challenges have a description and a JustGiving link.';
  if (isDareBoard) {
    typeOptions = [['dare', TYPE_LABELS.dare]];
    typeHint = 'A dare board has walkers, dares and donations, so it cannot be changed into something else.';
  } else if (!isNew) {
    typeOptions = typeOptions.filter(([value]) => value !== 'dare');
    typeHint = 'To run a dare board, start a new fundraiser instead.';
  }
  const type = select(typeOptions, fundraiser.type, { name: 'type' });
  type.disabled = isDareBoard;

  const summary = h('textarea', { name: 'summary', rows: 3 });
  const summaryField = field('Short description', summary, { hint: 'Shown on the cards people see first.' });
  const updateSummaryCount = addCounter(summaryField, summary, 200);
  const body = h('textarea', { name: 'body', rows: 8 });

  const about = h('fieldset', { class: 'group' }, h('legend', { text: 'What it is' }),
    field('Title', title),
    field('Type', type, { hint: typeHint }),
    summaryField,
    field('Longer description', body, { hint: 'Plain text. Leave a blank line between paragraphs.' }));

  const photo = h('input', { name: 'photo_url', type: 'url', inputMode: 'url', autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
  const photoImage = h('img', { alt: 'Preview of the photo', hidden: true, referrerPolicy: 'no-referrer' });
  const photoNote = h('p', { class: 'hint', role: 'status' });
  // The note is a live region, so it stays in the page even when there is nothing to say.
  const photoPreview = h('div', { class: 'photo-preview' }, photoImage, photoNote);
  let photoTimer = 0;
  function updatePhoto() {
    const url = photo.value.trim();
    photoImage.hidden = true;
    if (url === '') {
      photoImage.removeAttribute('src');
      photoNote.textContent = '';
    } else if (!/^https:\/\/\S+$/i.test(url)) {
      photoImage.removeAttribute('src');
      photoNote.textContent = 'The link has to start with https://';
    } else {
      photoNote.textContent = 'Loading the photo…';
      photoImage.src = url;
    }
  }
  photoImage.addEventListener('load', () => {
    photoImage.hidden = false;
    photoNote.textContent = 'This is the photo the site will show.';
  });
  photoImage.addEventListener('error', () => {
    photoImage.hidden = true;
    photoNote.textContent = 'That link did not load as a picture. Check it opens the picture itself and not a web page.';
  });
  photo.addEventListener('input', () => {
    clearTimeout(photoTimer);
    photoTimer = setTimeout(updatePhoto, 600);
  });
  const photoSet = h('fieldset', { class: 'group' }, h('legend', { text: 'Photo' }),
    field('Photo link', photo, { hint: 'This site cannot store pictures, so the photo has to be online somewhere else already. Paste its link here, starting with https://. Leave it blank and the site draws its own placeholder.' }),
    photoPreview);

  const target = h('input', { name: 'target', inputMode: 'decimal', autocomplete: 'off' });
  const eventDate = h('input', { name: 'event_date', maxLength: 60, autocomplete: 'off' });
  const place = h('input', { name: 'place', maxLength: 80, autocomplete: 'off' });
  const facts = h('fieldset', { class: 'group' }, h('legend', { text: 'Target, date and place' }),
    field('Target in pounds', target, { hint: 'Like 500. Leave it blank for no target.', className: 'field-short' }),
    h('div', { class: 'fields fields-2' },
      field('Date, as you would like it shown', eventDate, { hint: 'Like Saturday 14 November, 7pm.' }),
      field('Place', place)));

  // Events and challenges
  const donateUrl = h('input', { name: 'donate_url', type: 'url', inputMode: 'url', autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
  const manualTotal = h('input', { name: 'manual_total', inputMode: 'decimal', autocomplete: 'off' });
  const donations = h('fieldset', { class: 'group' }, h('legend', { text: 'Donations' }),
    field('JustGiving donate link', donateUrl, { hint: 'The Donate button opens this page. It has to be a justgiving.com address.' }),
    field('Total raised so far, in pounds', manualTotal, { hint: 'The site does not read this from JustGiving, so type in the latest figure when it changes.', className: 'field-short' }));

  // Dare boards
  const closesAt = h('input', { name: 'closes_at', type: 'datetime-local' });
  const groupEnabled = h('input', { name: 'group_enabled', type: 'checkbox', id: 'group-enabled' });
  const groupWinners = h('input', { name: 'group_winners', type: 'number', min: '1', max: '10', inputMode: 'numeric', required: true });
  const walkerWinners = h('input', { name: 'walker_winners', type: 'number', min: '1', max: '10', inputMode: 'numeric', required: true });
  const otherBoards = state.overview.fundraisers.filter((f) => f.type === 'dare');
  const copyFrom = isNew && otherBoards.length
    ? select([['', 'Start with no walkers'], ...otherBoards.map((f) => [f.id, `Copy the walkers from ${f.title}`])], '', { name: 'copy_walkers_from' })
    : null;
  const dareSet = h('fieldset', { class: 'group' }, h('legend', { text: 'The dare list' }),
    field('List closes at', closesAt, { hint: 'After this time nobody can suggest, vote or donate. Leave it blank to keep the list open.' }),
    h('label', { class: 'check', htmlFor: 'group-enabled' }, groupEnabled, h('span', { text: 'Show free group dares on the site' })),
    h('div', { class: 'fields fields-2' },
      field('Winning dares for the group', groupWinners, { hint: 'From 1 to 10.' }),
      field('Winning dares for each walker', walkerWinners, { hint: 'From 1 to 10.' })),
    copyFrom && field('Walkers', copyFrom, { hint: 'You can add, rename and hide walkers after you save.' }),
    isNew && !copyFrom && h('p', { class: 'hint', text: 'You can add walkers after you save.' }));

  const statusChoice = (value, note) => h('label', { class: 'choice' },
    h('input', { type: 'radio', name: 'status', value }),
    h('span', {}, h('strong', { text: STATUS_LABELS[value] }), h('span', { class: 'choice-note', text: note })));
  const visibility = h('fieldset', { class: 'group' }, h('legend', { text: 'Who can see it' }),
    h('div', { class: 'choices' },
      statusChoice('draft', 'Only leaders can see it.'),
      statusChoice('live', 'On the site.'),
      statusChoice('finished', 'Listed as finished, no longer taking dares or donations.')));

  const save = button(isNew ? 'Create fundraiser' : 'Save changes', { type: 'submit' });
  const saveError = errorLine();
  const saveStatus = statusLine();
  form.append(about, photoSet, facts, donations, dareSet, visibility, h('div', { class: 'save-bar' }, save, saveError, saveStatus));
  page.append(form);

  function syncType() {
    const isDare = type.value === 'dare';
    dareSet.hidden = !isDare;
    dareSet.disabled = !isDare;
    donations.hidden = isDare;
    donations.disabled = isDare;
  }
  type.addEventListener('change', syncType);

  function fill() {
    title.value = fundraiser.title ?? '';
    type.value = fundraiser.type;
    summary.value = fundraiser.summary ?? '';
    body.value = fundraiser.body ?? '';
    photo.value = fundraiser.photo_url ?? '';
    target.value = poundsField(fundraiser.target_pence);
    eventDate.value = fundraiser.event_date ?? '';
    place.value = fundraiser.place ?? '';
    donateUrl.value = fundraiser.donate_url ?? '';
    manualTotal.value = poundsField(fundraiser.manual_total_pence);
    closesAt.value = fundraiser.closes_at ? toLocalInput(fundraiser.closes_at) : '';
    groupEnabled.checked = Boolean(fundraiser.group_enabled);
    groupWinners.value = fundraiser.group_winners ?? 3;
    walkerWinners.value = fundraiser.walker_winners ?? 1;
    for (const radio of form.querySelectorAll('[name="status"]')) radio.checked = radio.value === fundraiser.status;
    syncType();
    updateSummaryCount();
    updatePhoto();
    updateHead();
  }

  const snapshot = () => [...form.elements].filter((control) => control.name)
    .map((control) => `${control.name}=${control.type === 'checkbox' || control.type === 'radio' ? `${control.value}:${control.checked}` : control.value}`).join('\n');

  fill();
  let clean = snapshot();
  isDirty = () => page.isConnected && snapshot() !== clean;
  form.addEventListener('input', () => setStatus(saveStatus, ''));

  // Every field goes each time. The server ignores the ones that don't apply to the type.
  const readFields = () => ({
    title: title.value,
    type: type.value,
    summary: summary.value,
    body: body.value,
    photo_url: photo.value.trim(),
    target: target.value,
    event_date: eventDate.value,
    place: place.value,
    status: form.querySelector('[name="status"]:checked')?.value ?? 'draft',
    donate_url: donateUrl.value.trim(),
    manual_total: manualTotal.value,
    closes_at: fromLocalInput(closesAt.value),
    group_enabled: groupEnabled.checked,
    group_winners: Number(groupWinners.value),
    walker_winners: Number(walkerWinners.value),
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    act(save, saveError, async () => {
      setStatus(saveStatus, '');
      const fields = readFields();
      if (isNew) {
        if (copyFrom && fields.type === 'dare' && copyFrom.value) fields.copy_walkers_from = Number(copyFrom.value);
        const created = await api('POST', 'fundraisers', fields);
        clean = snapshot();
        await reload();
        state.tab = fields.status;
        state.flash = fields.status === 'draft'
          ? 'Created. It is a draft, so only leaders can see it.'
          : `Created. ${SAVED_NOTES[fields.status].slice('Saved. '.length)}`;
        location.hash = `#f/${created.id}`;
        return;
      }
      await api('PUT', `fundraisers/${id}`, fields);
      detail = await api('GET', `fundraisers/${id}`);
      fundraiser = detail.fundraiser;
      fill();
      clean = snapshot();
      setStatus(saveStatus, SAVED_NOTES[fundraiser.status]);
      await reload();
    }, isNew ? 'Creating…' : 'Saving…');
  });

  if (isDareBoard) page.append(...dareBoardSections(id, () => detail, (fresh) => { detail = fresh; }));
  mount(page, isNew ? 'New fundraiser' : fundraiser.title, options);
}

// The three collapsible sections under a dare board's details.
function dareBoardSections(id, getDetail, setDetail) {
  const fold = (titleText, count, ...content) => {
    const counter = h('span', { class: 'fold-count' });
    const node = h('details', { class: 'fold' },
      h('summary', {}, h('span', {}, h('span', { text: titleText }), counter), icon('down')),
      h('div', { class: 'fold-body' }, content));
    const setCount = (value) => { counter.textContent = value === null ? '' : ` (${value})`; };
    setCount(count);
    return { node, setCount };
  };
  const refetch = async () => {
    const fresh = await api('GET', `fundraisers/${id}`);
    setDetail(fresh);
    return fresh;
  };

  // Dares on the list
  const daresStatus = statusLine();
  const daresList = h('ul', { class: 'rows' });
  const daresFold = fold('Dares on the list', getDetail().dares.length, daresStatus, daresList);

  function renderDares() {
    const { dares } = getDetail();
    daresFold.setCount(dares.length);
    if (dares.length === 0) {
      daresList.replaceChildren(h('li', { class: 'hint', text: 'No dares on the list yet. New ones wait under To do until a leader reads them.' }));
      return;
    }
    daresList.replaceChildren(...dares.map((dare) => {
      const error = errorLine();
      const remove = button('Take off the list', { quiet: true });
      remove.append(h('span', { class: 'visually-hidden', text: `: ${dare.title}` }));
      remove.addEventListener('click', () => {
        if (!confirm(`Take "${dare.title}" off the list? Its donations stay on JustGiving but no longer count here.`)) return;
        act(remove, error, async () => {
          await api('PUT', `dares/${dare.id}`, { status: 'rejected' });
          await refetch();
          renderDares();
          const text = `"${dare.title}" is off the list.`;
          setStatus(daresStatus, text);
          daresFold.node.querySelector('summary').focus();
          announce(text);
          await reload();
        });
      });
      const score = dare.target_kind === 'group'
        ? plural(dare.votes, 'vote')
        : dare.total_pence > 0 ? `${money(dare.total_pence)} confirmed` : 'No confirmed donations yet';
      return h('li', { class: 'row' },
        h('p', { class: 'row-title', text: dare.title }),
        h('p', { class: 'row-meta' }, h('span', { class: 'code', text: dare.code })),
        h('p', { class: 'row-meta', text: `For ${midSentence(dare.target_name)}. ${score}.${dare.reviewed_by ? ` Put on the list by ${dare.reviewed_by}.` : ''}` }),
        error,
        h('div', { class: 'actions' }, remove));
    }));
  }
  renderDares();

  // Add a donation yourself
  const code = h('input', { name: 'code', required: true, autocomplete: 'off', autocapitalize: 'characters', spellcheck: false });
  const amount = h('input', { name: 'amount', inputMode: 'decimal', required: true, autocomplete: 'off' });
  const donor = h('input', { name: 'donor_name', maxLength: 60, autocomplete: 'off' });
  const pledgeButton = button('Add donation', { type: 'submit' });
  const pledgeError = errorLine();
  const pledgeStatus = statusLine();
  const pledgeForm = h('form', {},
    field('Dare code', code, { hint: 'It looks like DARE-K7QM.', className: 'field-short' }),
    field('Amount in pounds', amount, { hint: 'Like 10 or 7.50.', className: 'field-short' }),
    field('Donor name (optional)', donor),
    pledgeButton, pledgeError, pledgeStatus);
  pledgeForm.addEventListener('input', () => setStatus(pledgeStatus, ''));
  pledgeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    act(pledgeButton, pledgeError, async () => {
      const sent = { code: code.value.trim().toUpperCase(), amount: amount.value.trim(), donor_name: donor.value };
      await api('POST', 'pledges', sent);
      pledgeForm.reset();
      setStatus(pledgeStatus, `Added. £${sent.amount.replace(/^£\s*/, '')} now counts towards ${sent.code}.`);
      await refetch();
      renderDares();
      await reload();
    }, 'Adding…');
  });
  const pledgeFold = fold('Add a donation yourself', null,
    h('p', { class: 'section-note', text: "For donations on a walker's JustGiving page that have a dare code in the message but were never logged here. These count straight away. Group dares run on free votes, so they can't take donations." }),
    pledgeForm);

  // Walkers and donation links
  const walkerRows = h('div', { class: 'rows' });

  // Each walker is one line that opens into its own small form, so a long team stays short.
  function walkerRow(target, open = false) {
    const isWalker = target.kind === 'walker';
    const name = h('input', { value: target.name, maxLength: 40, required: true, autocomplete: 'off' });
    const url = isWalker ? h('input', { type: 'url', inputMode: 'url', value: target.jg_url, autocomplete: 'off', autocapitalize: 'none', spellcheck: false }) : null;
    const save = button('Save', { type: 'submit' });
    const error = errorLine();
    const status = statusLine();
    const label = h('span', { class: 'person-name' });
    const note = h('span', { class: 'person-state' });
    const describe = () => {
      label.textContent = target.name;
      if (!isWalker) note.textContent = 'The list everyone shares';
      else if (!target.active) note.textContent = 'Hidden from the site';
      else note.textContent = target.jg_url ? '' : 'No JustGiving link yet';
    };
    describe();
    // The whole row goes each time, because a missing "active" would show a hidden walker again.
    const send = (active) => api('PUT', `targets/${target.id}`, { name: name.value, jg_url: url ? url.value.trim() : target.jg_url, active });
    const form = h('form', { class: 'walker' },
      field(isWalker ? 'Name' : 'Name of the group list', name),
      isWalker && field('JustGiving page link', url),
      !isWalker && h('p', { class: 'hint', text: 'To hide this list, untick "Show free group dares on the site" above.' }),
      error);
    const actions = h('div', { class: 'actions' }, save);
    const node = h('details', { class: 'person' }, h('summary', {}, h('span', { class: 'person-words' }, label, note), icon('down')), form);
    node.open = open;
    form.addEventListener('input', () => setStatus(status, ''));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      act(save, error, async () => {
        await send(Boolean(target.active));
        target.name = name.value.trim();
        if (url) target.jg_url = url.value.trim();
        describe();
        setStatus(status, 'Saved.');
      }, 'Saving…');
    });
    if (isWalker) {
      const toggle = button(target.active ? 'Hide from the site' : 'Show on the site', { quiet: true });
      toggle.append(h('span', { class: 'visually-hidden', text: `: ${target.name}` }));
      toggle.addEventListener('click', () => act(toggle, error, async () => {
        const nowActive = !target.active;
        await send(nowActive);
        const fresh = (await refetch()).targets.find((t) => t.id === target.id) ?? { ...target, active: nowActive ? 1 : 0 };
        const replacement = walkerRow(fresh, true);
        node.replaceWith(replacement);
        replacement.querySelector('.button-quiet').focus();
        announce(`${fresh.name} is now ${nowActive ? 'shown on' : 'hidden from'} the site.`);
      }));
      actions.append(toggle);
    }
    form.append(actions, status);
    return node;
  }

  const walkerCount = () => getDetail().targets.filter((t) => t.kind === 'walker').length;
  function renderWalkers() {
    walkerRows.replaceChildren(...getDetail().targets.map((target) => walkerRow(target)));
  }
  renderWalkers();

  const walkerName = h('input', { name: 'name', maxLength: 40, required: true, autocomplete: 'off' });
  const walkerUrl = h('input', { name: 'jg_url', type: 'url', inputMode: 'url', autocomplete: 'off', autocapitalize: 'none', spellcheck: false });
  const walkerButton = button('Add walker', { type: 'submit' });
  const walkerError = errorLine();
  const walkerStatus = statusLine();
  const walkerForm = h('form', { class: 'walker' },
    field('Name', walkerName),
    field('JustGiving page link', walkerUrl, { hint: 'Their own justgiving.com page. You can add it later.' }),
    h('div', { class: 'actions' }, walkerButton), walkerError, walkerStatus);
  const walkersFold = fold('Walkers and donation links', walkerCount(),
    h('p', { class: 'section-note', text: 'Each walker has their own dare list. Donations for their dares go to their own JustGiving page.' }),
    walkerRows,
    h('h3', { class: 'subhead', text: 'Add a walker' }),
    walkerForm);
  walkerForm.addEventListener('input', () => setStatus(walkerStatus, ''));
  walkerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    act(walkerButton, walkerError, async () => {
      const added = walkerName.value.trim();
      await api('POST', 'walkers', { name: added, jg_url: walkerUrl.value.trim(), fundraiser_id: id });
      walkerForm.reset();
      await refetch();
      renderWalkers();
      walkersFold.setCount(walkerCount());
      setStatus(walkerStatus, `${added} is added.`);
    }, 'Adding…');
  });

  return [h('h2', { class: 'section', text: 'Dares, donations and walkers' }), daresFold.node, pledgeFold.node, walkersFold.node];
}

/* Site */

function renderSite(options) {
  const page = h('div', { class: 'page page-narrow' }, pageHeading('Site'),
    h('p', { class: 'lede', text: 'The words on the homepage and the two information pages, and the JustGiving pages behind the Everest total.' }));
  const dirtyChecks = [];

  function textPanel({ key, heading, hint, rows, max }) {
    let saved = state.overview.site[key];
    const area = h('textarea', { rows, value: saved, id: `site-${key}` });
    const wrap = h('div', { class: 'field' }, area, h('p', { class: 'hint', id: `site-${key}-hint`, text: hint }));
    area.setAttribute('aria-describedby', `site-${key}-hint`);
    if (max) addCounter(wrap, area, max);
    const save = button('Save', { type: 'submit' });
    const error = errorLine();
    const status = statusLine();
    const form = h('form', { class: 'panel' }, h('h2', {}, h('label', { htmlFor: area.id, text: heading })), wrap, save, error, status);
    area.addEventListener('input', () => setStatus(status, ''));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      act(save, error, async () => {
        if (area.value === saved) {
          setStatus(status, 'Nothing has changed since the last save.');
          return;
        }
        await api('PUT', 'site', { [key]: area.value });
        await reload();
        saved = state.overview.site[key];
        area.value = saved;
        area.dispatchEvent(new Event('input'));
        setStatus(status, `Saved. ${heading} is updated on the site.`);
      }, 'Saving…');
    });
    dirtyChecks.push(() => area.value !== saved);
    return form;
  }

  page.append(h('div', { class: 'section' },
    textPanel({ key: 'site_intro', heading: 'Homepage intro', hint: 'The few lines under the main heading on the homepage.', rows: 4, max: 300 }),
    textPanel({ key: 'about_text', heading: 'About page', hint: 'Plain text. Leave a blank line between paragraphs.', rows: 12 }),
    textPanel({ key: 'challenge_text', heading: 'Our Challenge page', hint: 'Plain text. Leave a blank line between paragraphs.', rows: 12 })));

  // JustGiving pages in the Everest total
  const everestHeading = h('h2', { id: 'everest-h', tabIndex: -1, text: 'JustGiving pages in the Everest total' });
  const everestStatus = statusLine();
  const pagesList = h('ul', { class: 'rows' });
  const hasKey = state.overview.everest.has_key;

  function renderPages() {
    const pages = state.overview.everest.pages;
    if (pages.length === 0) {
      pagesList.replaceChildren(h('li', { class: 'hint', text: 'No pages yet. Add the first one below.' }));
      return;
    }
    pagesList.replaceChildren(...pages.map((entry) => {
      const name = entry.owner || entry.short_name;
      const error = errorLine();
      const remove = button('Remove', { quiet: true });
      remove.append(h('span', { class: 'visually-hidden', text: ` ${name}` }));
      remove.addEventListener('click', () => {
        if (!confirm(`Remove ${name} from the Everest total?`)) return;
        act(remove, error, async () => {
          await api('DELETE', `everest/pages/${encodeURIComponent(entry.short_name)}`);
          await reload();
          renderPages();
          const text = `${name} is removed from the Everest total.`;
          setStatus(everestStatus, text);
          everestHeading.focus();
          announce(text);
        });
      });
      let figures = 'Not read from JustGiving yet';
      if (entry.raised_pence !== null) {
        figures = entry.target_pence > 0
          ? `${money(entry.raised_pence)} raised of ${money(entry.target_pence)}`
          : `${money(entry.raised_pence)} raised`;
      }
      return h('li', { class: 'row row-split' },
        h('div', {},
          h('p', { class: 'row-title', text: name }),
          h('p', { class: 'row-meta', text: entry.owner ? `${figures}. Page name: ${entry.short_name}` : figures }),
          entry.failed ? h('p', { class: 'warn', text: 'JustGiving did not answer for this page last time, so this is the last figure it gave.' }) : null),
        h('div', { class: 'actions' }, remove),
        error);
    }));
  }
  renderPages();

  const pageUrl = h('input', { name: 'url', required: true, autocomplete: 'off', autocapitalize: 'none', spellcheck: false, inputMode: 'url' });
  const addButton = button('Add page', { type: 'submit' });
  const addError = errorLine();
  const addForm = h('form', {},
    field('JustGiving page link', pageUrl, { hint: 'Like https://www.justgiving.com/fundraising/your-page.' }),
    addButton, addError);
  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    act(addButton, addError, async () => {
      await api('POST', 'everest/pages', { url: pageUrl.value.trim() });
      addForm.reset();
      await reload();
      renderPages();
      setStatus(everestStatus, 'Added. It now counts towards the Everest total.');
    }, 'Adding…');
  });

  const refresh = button('Check JustGiving now', { quiet: true });
  const refreshError = errorLine();
  refresh.addEventListener('click', () => act(refresh, refreshError, async () => {
    const result = await api('POST', 'everest/refresh');
    await reload();
    renderPages();
    setStatus(everestStatus, result.failed
      ? `Checked. JustGiving did not answer for ${plural(result.failed, 'page')}.`
      : 'Checked. The figures are up to date.');
  }, 'Checking…'));

  page.append(h('section', { class: 'panel', 'aria-labelledby': 'everest-h' },
    everestHeading,
    h('p', { class: 'section-note', text: 'The Everest total on the site adds up the pages below. The site checks them every 15 minutes.' }),
    hasKey ? null : h('p', { class: 'warn', text: 'The JustGiving key is not set up yet, so the site cannot read these pages. Ask the site owner to add it.' }),
    hasKey ? h('div', { class: 'actions' }, refresh) : null,
    hasKey ? refreshError : null,
    everestStatus,
    pagesList,
    h('h3', { class: 'subhead', text: 'Add a page' }),
    addForm));

  isDirty = () => page.isConnected && dirtyChecks.some((check) => check());
  mount(page, 'Site', options);
}

/* Logins */

async function renderLogins(token, options) {
  const page = h('div', { class: 'page page-narrow' }, pageHeading('Logins'),
    h('p', { class: 'lede', text: 'Each leader signs in with their own key. You can stop a key working at any time.' }));

  const keyHolder = h('div', { class: 'key-holder' });
  const name = h('input', { name: 'name', maxLength: 40, required: true, autocomplete: 'off' });
  const create = button('Create a key', { type: 'submit' });
  const createError = errorLine();
  const createForm = h('form', { class: 'panel section' }, h('h2', { text: 'Give a leader a key' }),
    field("Leader's name", name, { hint: 'Their name is saved next to the dares and donations they check.' }),
    create, createError);

  const listStatus = statusLine();
  const listHeading = h('h2', { tabIndex: -1, text: 'Leader keys' });
  const list = h('ul', { class: 'rows' });
  const listError = errorLine();
  let logins = [];

  function showKey(leader, key) {
    const copy = button('Copy the key');
    const copied = statusLine();
    const keyText = h('p', { class: 'key', text: key });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(key);
        setStatus(copied, 'Copied.');
      } catch {
        const range = document.createRange();
        range.selectNodeContents(keyText);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        setStatus(copied, 'The key is selected. Copy it from there.');
      }
    });
    const done = button('I have saved it', { quiet: true });
    done.addEventListener('click', () => {
      keyHolder.replaceChildren();
      listHeading.focus();
    });
    const heading = h('h2', { tabIndex: -1, text: `${leader}'s key` });
    keyHolder.replaceChildren(h('section', { class: 'keybox' },
      heading,
      h('p', {}, h('strong', { text: 'This key is shown once and cannot be shown again.' }),
        ` Save it in a password manager now, then send it to ${leader} privately. They type it into the sign-in box instead of a password.`),
      keyText,
      h('div', { class: 'actions' }, copy, done),
      copied));
    heading.focus();
    announce(`${leader}'s key is ready. It is shown once, so save it now.`);
  }

  function renderList() {
    if (logins.length === 0) {
      list.replaceChildren(h('li', { class: 'hint', text: 'No leader keys yet.' }));
      return;
    }
    list.replaceChildren(...logins.map((login) => {
      const row = h('li', { class: 'row row-split' },
        h('div', {},
          h('p', { class: 'row-title', text: login.name }),
          h('p', { class: 'row-meta' },
            h('span', { class: `chip ${login.revoked ? 'chip-revoked' : 'chip-live'}`, text: login.revoked ? 'Revoked' : 'Active' }),
            `Created ${day(login.created_at)}`)));
      if (!login.revoked) {
        const error = errorLine();
        const revoke = button('Revoke', { quiet: true });
        revoke.append(h('span', { class: 'visually-hidden', text: ` ${login.name}'s key` }));
        revoke.addEventListener('click', () => {
          if (!confirm(`Revoke ${login.name}'s key? It stops working straight away and cannot be switched back on. They would need a new key.`)) return;
          act(revoke, error, async () => {
            await api('PUT', `logins/${login.id}`, {});
            ({ logins } = await api('GET', 'logins'));
            renderList();
            const text = `${login.name}'s key is revoked.`;
            setStatus(listStatus, text);
            listHeading.focus();
            announce(text);
          });
        });
        row.append(h('div', { class: 'actions' }, revoke), error);
      }
      return row;
    }));
  }

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    act(create, createError, async () => {
      const created = await api('POST', 'logins', { name: name.value });
      createForm.reset();
      showKey(created.name, created.key);
      ({ logins } = await api('GET', 'logins'));
      renderList();
    }, 'Creating…');
  });

  page.append(createForm, keyHolder, h('section', { class: 'panel', 'aria-label': 'Leader keys' }, listHeading,
    h('p', { class: 'section-note', text: 'The owner password is not on this list.' }), listStatus, listError, list));
  $('view').replaceChildren(h('p', { class: 'load-note', text: 'Loading…' }));
  try {
    ({ logins } = await api('GET', 'logins'));
  } catch (error) {
    if (token !== viewToken || !state.overview) return;
    showError(listError, error);
  }
  if (token !== viewToken) return;
  if (listError.hidden) renderList();
  mount(page, 'Logins', options);
}

/* Start */

password = readStored();
if (password) {
  let remembered = false;
  try {
    remembered = Boolean(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage is blocked, so there is nothing to remember.
  }
  $('remember').checked = remembered;
  $('loading').hidden = false;
  enter().catch((error) => {
    password = '';
    // A wrong saved password is thrown away. Anything else, like no signal, keeps it for next time.
    if (error.status === 401) forget();
    showSignIn(error.status === 401 ? 'Your saved sign-in no longer works. Sign in again.' : error.message);
  });
} else {
  showSignIn(undefined, false);
}
