// The About and Our Challenge pages. Their text is written in the admin page.
import { $, getSite, renderEverest, renderProse } from './site.js';

getSite(document.body.dataset.page).then((site) => {
  renderProse($('body'), site.page.body);
  if (site.everest && $('everest-figures')) {
    renderEverest(site.everest);
    $('everest-missing').hidden = true;
    const checked = new Date(site.everest.updated_at).toLocaleString('en-GB', { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'Europe/London' });
    $('everest-note').textContent = `Added up from our JustGiving pages. Last checked ${checked}.`;
  }
}).catch(() => {
  $('body').replaceChildren();
  $('body').append(Object.assign(document.createElement('p'), { textContent: 'This page could not be loaded. Refresh to try again.' }));
});
