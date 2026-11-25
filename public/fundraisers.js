import { $, card, getSite, renderEverest } from './site.js';

getSite().then((site) => {
  renderEverest(site.everest);
  const live = site.fundraisers.filter((f) => f.status === 'live');
  const finished = site.fundraisers.filter((f) => f.status === 'finished');
  $('status').hidden = true;
  $('live-cards').replaceChildren(...live.map(card));
  $('live-empty').hidden = live.length > 0;
  $('finished-cards').replaceChildren(...finished.map(card));
  $('finished-section').hidden = finished.length === 0;
}).catch(() => {
  $('status').textContent = 'The fundraisers could not be loaded. Refresh the page to try again.';
});
