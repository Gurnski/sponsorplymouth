import { $, TYPE_LABELS, card, el, facts, fundraiserUrl, getSite, icon, photo, renderEverest, tally } from './site.js';

function feature(fundraiser) {
  const article = el('article', 'feature');
  const label = el('span', 'badge');
  label.append(icon('star'), 'Featured fundraiser');
  article.append(photo(fundraiser, { label }));

  const body = el('div', 'feature-body');
  const type = el('p', 'feature-type');
  type.append(icon(fundraiser.type), TYPE_LABELS[fundraiser.type]);
  const title = el('h2', '', fundraiser.title);
  body.append(type, title);
  if (fundraiser.summary) body.append(el('p', 'feature-summary', fundraiser.summary));
  const line = facts(fundraiser);
  if (line) body.append(el('p', 'feature-facts', line));
  body.append(...tally(fundraiser.total_pence, fundraiser.target_pence, fundraiser.percent));
  const button = el('a', 'button button-big', fundraiser.type === 'dare' ? 'See the dares' : 'View fundraiser');
  button.href = fundraiserUrl(fundraiser);
  body.append(button);
  article.append(body);
  return article;
}

getSite().then((site) => {
  if (site.intro) $('intro').textContent = site.intro;
  renderEverest(site.everest);

  const live = site.fundraisers.filter((f) => f.status === 'live');
  const featured = live.find((f) => f.slug === site.featured);
  $('featured-status').hidden = true;
  $('featured').hidden = !featured;
  if (featured) $('featured-slot').replaceChildren(feature(featured));

  const others = live.filter((f) => f !== featured);
  $('cards').replaceChildren(...others.map(card));
  $('cards-empty').hidden = others.length > 0;
  $('more-heading').textContent = featured ? 'More fundraisers and challenges' : 'Fundraisers and challenges';
}).catch(() => {
  $('featured-status').textContent = 'The fundraisers could not be loaded. Refresh the page to try again.';
});
