// An event or challenge: what it is, how much it has raised and a button to donate on JustGiving.
import { $, TYPE_LABELS, el, getJson, icon, leaderHeaders, photo, renderProse, tally } from './site.js';

const slug = location.pathname.split('/').filter(Boolean)[1] ?? '';

// Drafts are only served to signed-in leaders, so a miss is retried once with their login.
async function load() {
  const path = `/api/fundraisers/${encodeURIComponent(slug)}`;
  try {
    return await getJson(path);
  } catch (error) {
    const headers = leaderHeaders();
    if (error.status !== 404 || !headers.authorization) throw error;
    return getJson(path, headers);
  }
}

function render({ fundraiser, preview }) {
  const finished = fundraiser.status === 'finished';
  document.title = `${fundraiser.title} | Sponsor University of Plymouth`;
  $('preview-note').hidden = !preview;
  $('title').textContent = fundraiser.title;
  $('lede').textContent = fundraiser.summary;
  $('type-badge').replaceChildren(icon(finished ? 'check' : fundraiser.type), finished ? `${TYPE_LABELS[fundraiser.type]}, finished` : TYPE_LABELS[fundraiser.type]);
  $('type-badge').hidden = false;

  const facts = [];
  if (fundraiser.event_date) facts.push(['event', fundraiser.event_date]);
  if (fundraiser.place) facts.push(['pin', fundraiser.place]);
  $('facts').replaceChildren(...facts.map(([name, text]) => {
    const fact = el('span');
    fact.append(icon(name), text);
    return fact;
  }));
  $('facts').hidden = facts.length === 0;

  $('photo-slot').replaceChildren(photo(fundraiser, { label: false }));
  $('tally').replaceChildren(...tally(fundraiser.total_pence, fundraiser.target_pence, fundraiser.percent));
  renderProse($('body'), fundraiser.body);

  const donate = $('donate');
  if (finished) {
    donate.hidden = true;
    $('give-note').textContent = 'This fundraiser has finished. Thank you to everyone who gave.';
  } else if (fundraiser.donate_url) {
    donate.href = fundraiser.donate_url;
  } else {
    donate.removeAttribute('href');
    donate.setAttribute('aria-disabled', 'true');
    donate.textContent = 'Donation link coming soon';
  }

  $('status').hidden = true;
  $('detail').hidden = false;
}

load().then(render).catch((error) => {
  $('title').textContent = error.status === 404 ? "That fundraiser isn't on the map" : 'Something went wrong';
  $('status').textContent = error.status === 404
    ? 'The link may be old, or the fundraiser may have been taken down.'
    : 'The fundraiser could not be loaded. Refresh the page to try again.';
});
