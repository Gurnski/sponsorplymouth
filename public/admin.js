const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'admin-password';

let password = '';
try {
  password = sessionStorage.getItem(STORAGE_KEY) ?? '';
} catch {
  // Private windows can block storage. The password then lasts until refresh.
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const money = (pence) => `£${(pence / 100).toFixed(2)}`;

async function api(method, path, body) {
  const response = await fetch(`/api/admin/${path}`, {
    method,
    headers: { authorization: `Bearer ${password}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error ?? 'That did not go through. Try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function showPanelError(error) {
  $('panel-error').textContent = error.message;
  $('panel-error').hidden = false;
  $('panel-error').scrollIntoView({ block: 'center' });
}

function actionButton(label, quiet, action) {
  const button = el('button', quiet ? 'button button-quiet' : 'button', label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await action();
      await refresh();
    } catch (error) {
      button.disabled = false;
      showPanelError(error);
    }
  });
  return button;
}

function item(title, metaLines, buttons) {
  const row = el('div', 'admin-item');
  row.append(el('p', 'admin-item-title', title));
  for (const line of metaLines.filter(Boolean)) row.append(el('p', 'admin-item-meta', line));
  const actions = el('div', 'admin-actions');
  actions.append(...buttons);
  row.append(actions);
  return row;
}

const setDare = (id, status) => api('PUT', `dares/${id}`, { status });
const setPledge = (id, status) => api('PUT', `pledges/${id}`, { status });

function renderDares(dares) {
  const pending = dares.filter((d) => d.status === 'pending');
  const live = dares.filter((d) => d.status === 'approved');
  $('pending-dares').replaceChildren(...(pending.length ? pending.map((d) =>
    item(d.title, [`For ${d.target_name}`, d.detail, d.suggested_by && `From ${d.suggested_by}`], [
      actionButton('Put on the list', false, () => setDare(d.id, 'approved')),
      actionButton('Turn down', true, () => setDare(d.id, 'rejected')),
    ])) : [el('p', 'admin-note', 'Nothing waiting.')]));
  $('live-dares').replaceChildren(...(live.length ? live.map((d) =>
    item(d.title, [`${d.code}, for ${d.target_name}`], [
      actionButton('Take off the list', true, () => {
        if (!confirm(`Take "${d.title}" off the list? Its donations stay on JustGiving but no longer count here.`)) return Promise.resolve();
        return setDare(d.id, 'rejected');
      }),
    ])) : [el('p', 'admin-note', 'No dares on the list yet.')]));
}

function renderPledges(pledges) {
  $('pledges').replaceChildren(...(pledges.length ? pledges.map((p) => {
    const row = item(`${money(p.amount_pence)} for "${p.title}"`,
      [`Code ${p.code}, on ${p.target_name}'s page`, p.donor_name && `Name given: ${p.donor_name}`, `Logged ${new Date(p.created_at).toLocaleString('en-GB')}`],
      [
        actionButton('Confirm', false, () => setPledge(p.id, 'confirmed')),
        actionButton("Can't find it", true, () => setPledge(p.id, 'rejected')),
      ]);
    if (p.jg_url) {
      const link = el('a', 'admin-link', 'Open their JustGiving page');
      link.href = p.jg_url;
      link.target = '_blank';
      link.rel = 'noopener';
      row.insertBefore(link, row.lastChild);
    }
    return row;
  }) : [el('p', 'admin-note', 'Nothing waiting.')]));
}

function renderTargets(targets) {
  $('targets').replaceChildren(...targets.map((target) => {
    const form = el('form', 'admin-form admin-item');
    const nameId = `t-name-${target.id}`;
    const urlId = `t-url-${target.id}`;
    const nameLabel = el('label', '', 'Name');
    nameLabel.htmlFor = nameId;
    const name = el('input');
    name.id = nameId;
    name.value = target.name;
    name.maxLength = 40;
    const urlLabel = el('label', '', 'JustGiving page link');
    urlLabel.htmlFor = urlId;
    const url = el('input');
    url.id = urlId;
    url.type = 'url';
    url.value = target.jg_url;
    form.append(nameLabel, name);
    if (target.kind === 'walker') form.append(urlLabel, url);

    const update = (active) => api('PUT', `targets/${target.id}`, { name: name.value, jg_url: url.value, active });
    const isActive = Boolean(target.active);
    const actions = el('div', 'admin-actions');
    const save = el('button', 'button', 'Save');
    save.type = 'button';
    save.addEventListener('click', async () => {
      try {
        await update(isActive);
        save.textContent = 'Saved';
        setTimeout(() => { save.textContent = 'Save'; }, 2000);
      } catch (error) {
        showPanelError(error);
      }
    });
    actions.append(save);
    if (target.kind === 'walker') {
      actions.append(actionButton(isActive ? 'Hide from the site' : 'Show on the site', true, () => update(!isActive)));
    }
    form.append(actions);
    form.addEventListener('submit', (event) => event.preventDefault());
    return form;
  }));
}

// Converts between a stored UTC time and the browser's local datetime-local format.
function toLocalInput(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderSettings(settings) {
  const form = $('settings');
  for (const key of ['challenge_title', 'group_name', 'charity_name', 'walk_date', 'group_winners', 'walker_winners']) {
    form.elements[key].value = settings[key] ?? '';
  }
  form.elements.closes_at.value = settings.closes_at ? toLocalInput(settings.closes_at) : '';
  form.elements.group_enabled.checked = settings.group_enabled === '1';
}

async function refresh() {
  const data = await api('GET', 'overview');
  $('panel-error').hidden = true;
  renderDares(data.dares);
  renderPledges(data.pledges);
  renderTargets(data.targets);
  return data;
}

async function signIn() {
  const data = await refresh();
  renderSettings(data.settings);
  $('login-form').hidden = true;
  $('panel').hidden = false;
}

function wireAdminForm(form, submitFn) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await submitFn(Object.fromEntries(new FormData(form)));
    } catch (error) {
      showPanelError(error);
    }
  });
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  password = $('password').value;
  $('login-error').hidden = true;
  try {
    await signIn();
    try {
      sessionStorage.setItem(STORAGE_KEY, password);
    } catch {
      // Staying signed in across refreshes is only a convenience.
    }
  } catch (error) {
    $('login-error').textContent = error.message;
    $('login-error').hidden = false;
  }
});

wireAdminForm($('add-pledge'), async (fields) => {
  await api('POST', 'pledges', fields);
  $('add-pledge').reset();
  await refresh();
});

wireAdminForm($('add-walker'), async (fields) => {
  await api('POST', 'walkers', fields);
  $('add-walker').reset();
  await refresh();
});

wireAdminForm($('settings'), async (fields) => {
  const closes = fields.closes_at ? new Date(fields.closes_at).toISOString() : '';
  await api('PUT', 'settings', { ...fields, closes_at: closes });
  $('settings-saved').hidden = false;
  setTimeout(() => { $('settings-saved').hidden = true; }, 3000);
});

if (password) {
  signIn().catch(() => {
    password = '';
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clean up if storage is blocked.
    }
  });
}
