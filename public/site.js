// Shared by every public page: the menu, the Everest strip and the fundraiser cards.

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Whole pounds read better on cards, so pence only show when there are some.
export function money(pence) {
  const pounds = pence / 100;
  return `£${pounds.toLocaleString('en-GB', Number.isInteger(pounds) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 24 24');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

export const TYPE_LABELS = { dare: 'Group Dare', event: 'Event', challenge: 'Challenge' };

// A leader who is signed in to /admin can open drafts on the public pages.
export function leaderHeaders() {
  try {
    const token = sessionStorage.getItem('admin-password') ?? localStorage.getItem('admin-password');
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export async function getJson(path, headers = {}) {
  const response = await fetch(path, { headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error ?? 'That could not be loaded.');
    error.status = response.status;
    throw error;
  }
  return data;
}

let siteRequest = null;
export function getSite(page) {
  if (page) return getJson(`/api/site?page=${encodeURIComponent(page)}`);
  siteRequest ??= getJson('/api/site');
  return siteRequest;
}

function badge(type, finished) {
  const node = el('span', finished ? 'badge badge-finished' : 'badge');
  node.append(icon(finished ? 'check' : type), finished ? 'Finished' : TYPE_LABELS[type]);
  return node;
}

// The photo, or the contour art for that type when there isn't one or it fails to load.
export function photo(fundraiser, { extraClass = '', label } = {}) {
  const box = el('div', `photo photo-${fundraiser.type}${extraClass ? ` ${extraClass}` : ''}`);
  box.append(icon(fundraiser.type, 'photo-mark'));
  if (fundraiser.photo_url.startsWith('https://')) {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove());
    img.src = fundraiser.photo_url;
    box.append(img);
  }
  if (label !== false) box.append(label ?? badge(fundraiser.type, fundraiser.status === 'finished'));
  return box;
}

// The route line: how far along the path to the target.
export function route(percent) {
  const line = el('div', percent >= 100 ? 'route route-reached' : 'route');
  line.setAttribute('role', 'img');
  line.setAttribute('aria-label', `${percent}% of the target raised`);
  const done = el('span', 'route-done');
  line.append(done);
  // Set after the first paint so the line is seen being walked.
  requestAnimationFrame(() => requestAnimationFrame(() => line.style.setProperty('--done', String(Math.min(percent, 100) / 100))));
  return line;
}

// "£110 of £300" with the percent and the route, or just the amount when no target is set.
// With no target and nothing raised yet there is nothing worth showing, so it returns nothing.
export function tally(totalPence, targetPence, percent) {
  const nodes = [];
  if (!(targetPence > 0) && !(totalPence > 0)) return nodes;
  const row = el('div', 'tally');
  const amount = el('p', 'tally-money');
  amount.append(el('strong', '', money(totalPence)), targetPence > 0 ? `of ${money(targetPence)}` : 'raised so far');
  row.append(amount);
  nodes.push(row);
  if (targetPence > 0 && percent !== null) {
    row.append(el('p', 'tally-percent', `${percent}%`));
    nodes.push(route(percent));
  }
  return nodes;
}

export function facts(fundraiser) {
  const parts = [];
  if (fundraiser.type === 'dare' && fundraiser.status === 'live') {
    parts.push(fundraiser.dares === 0 ? 'No dares yet. Suggest the first.' : `${fundraiser.dares} ${fundraiser.dares === 1 ? 'dare' : 'dares'} on the list`);
  }
  if (fundraiser.event_date) parts.push(fundraiser.event_date);
  if (fundraiser.place) parts.push(fundraiser.place);
  return parts.join(', ');
}

export const fundraiserUrl = (fundraiser) => `/f/${fundraiser.slug}`;

export function card(fundraiser) {
  const item = el('li');
  const article = el('article', 'card');
  article.append(photo(fundraiser));
  const body = el('div', 'card-body');
  const top = el('div', 'card-top');
  const title = el('h3', 'card-title');
  const link = el('a', '', fundraiser.title);
  link.href = fundraiserUrl(fundraiser);
  title.append(link);
  const go = el('span', 'card-go');
  go.append(icon('arrow'));
  top.append(title, go);
  body.append(top);
  if (fundraiser.summary) body.append(el('p', 'card-summary', fundraiser.summary));
  const line = facts(fundraiser);
  if (line) body.append(el('p', 'card-facts', line));
  body.append(...tally(fundraiser.total_pence, fundraiser.target_pence, fundraiser.percent));
  article.append(body);
  item.append(article);
  return item;
}

export function renderEverest(everest) {
  const figures = $('everest-figures');
  if (!figures || !everest) return;
  figures.replaceChildren(...tally(everest.raised_pence, everest.target_pence, everest.percent));
  figures.hidden = false;
}

// Plain text from the admin page becomes paragraphs. Never HTML.
export function renderProse(container, text) {
  const paragraphs = String(text ?? '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  container.replaceChildren(...paragraphs.map((part) => {
    const p = el('p');
    part.split('\n').forEach((line, index) => {
      if (index > 0) p.append(el('br'));
      p.append(line);
    });
    return p;
  }));
}

function initNav() {
  const bar = document.querySelector('.topbar');
  const toggle = document.querySelector('.nav-toggle');
  const subToggle = document.querySelector('.nav-sub-toggle');
  if (!bar || !toggle || !subToggle) return;

  const setMenu = (open) => {
    bar.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  const setSub = (open) => subToggle.setAttribute('aria-expanded', String(open));

  toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
  subToggle.addEventListener('click', () => setSub(subToggle.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (subToggle.getAttribute('aria-expanded') === 'true') {
      setSub(false);
      if (subToggle.offsetParent) subToggle.focus();
    } else if (toggle.getAttribute('aria-expanded') === 'true') {
      setMenu(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.nav-sub')) setSub(false);
    if (!event.target.closest('.topbar')) setMenu(false);
  });
  subToggle.parentElement.addEventListener('focusout', (event) => {
    if (!subToggle.parentElement.contains(event.relatedTarget) && matchMedia('(min-width: 60rem)').matches) setSub(false);
  });
}

function fillNav(site) {
  const list = $('nav-fundraisers');
  if (!list) return;
  const live = site.fundraisers.filter((f) => f.status === 'live');
  list.append(...live.map((f) => {
    const item = el('li');
    const link = el('a', '', f.title);
    link.href = fundraiserUrl(f);
    if (location.pathname === link.pathname) link.setAttribute('aria-current', 'page');
    item.append(link);
    return item;
  }));
}

initNav();
getSite().then(fillNav).catch(() => {
  // The menu still has the link to every fundraiser, so nothing to show here.
});
