import { cases, time } from './cases.js';
import { demoDefects } from './defects.js';

const app = document.querySelector('#app');
const people = ['Minji', 'Junho', 'Sora', 'Yuna', 'Jimin'];
const html = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const badge = (value) => `<span class="badge ${html(String(value).toLowerCase())}">${html(value)}</span>`;

async function api(path, body) {
  const options = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  return { code: response.status, ...await response.json() };
}

const panel = (title, contents, id) => `<section class="panel"${id ? ` id="${id}"` : ''}><h2>${html(title)}</h2>${contents}</section>`;

function heading(title, subtitle) {
  return `<h1>${html(title)}</h1><p class="lede">${html(subtitle)}</p>`;
}

function showError(message) {
  let element = document.querySelector('#page-error');
  if (!element) {
    element = document.createElement('p');
    element.id = 'page-error';
    element.className = 'toast error';
    app.prepend(element);
  }
  element.textContent = message;
}

function onClick(root, fn) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    try {
      await fn(button.dataset.action, button);
    } catch (error) {
      showError(error.message);
    }
  });
}

function required(result) {
  if (result.code >= 400) throw new Error(result.message);
  return result;
}

async function dashboard() {
  document.querySelector('#review-link').setAttribute('aria-current', 'page');
  app.innerHTML = heading('Release board', 'Validate the reservation rules in Chrome and inspect the evidence before approving a release.') +
    '<p id="page-error" class="toast error" role="status"></p><div id="board"></div>';
  const content = document.querySelector('#board');
  let selected;
  let showingArchive = false;
  let busy = false;
  let lastView;
  async function refresh() {
    const model = required(await api('/api/board'));
    const view = JSON.stringify([model, selected, showingArchive]);
    if (!busy && view !== lastView) {
      render(model);
      lastView = view;
    }
  }
  function render(model) {
    const rows = cases.map((scenario) => {
      const report = model.results[String(scenario.id)];
      const status = report?.status ?? (model.runningCases.includes(scenario.id) ? 'Running' : 'Pending');
      return `<tr><td>${scenario.id}</td><td>${html(scenario.title)}</td><td>${badge(status)}</td>
        <td class="actions"><button data-action="demo" data-case="${scenario.id}">Open scenario</button>
        <button data-action="run-one" data-case="${scenario.id}" ${model.running ? 'disabled' : ''}>Run Kane</button>
        ${report ? `<button data-action="details" data-case="${scenario.id}">Evidence</button>` : ''}
        ${model.archive[String(scenario.id)] && model.archive[String(scenario.id)].id !== report?.id ? `<button data-action="archive" data-case="${scenario.id}">Prior evidence</button>` : ''}</td></tr>`;
    }).join('');
    const report = (showingArchive ? model.archive : model.results)[String(selected)];
    const evidence = report ? `<div class="stack">
      ${showingArchive ? `<p class="subtle">Archived run · code ${html(report.signature.split(':')[0].slice(0, 8))}</p>` : ''}
      <p>${html(report.summary || report.reason)}</p>
      ${report.screenshot ? `<img class="evidence-image" src="/api/board/evidence/${html(report.id)}" alt="Kane's browser screenshot">` : ''}
      ${report.comparison?.length ? `<table><thead><tr><th>Field</th><th>Browser</th><th>Database</th></tr></thead><tbody>${report.comparison.map(({ field, observed, expected }) => `<tr><td>${html(field)}</td><td>${html(observed)}</td><td>${html(expected)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${report.conditions?.length ? `<p>Browser invariants ${html(report.conditions.map((item) => item ? 'pass' : 'fail').join(' · '))}</p>` : ''}
      ${report.network?.length ? `<details><summary>Browser network evidence</summary><pre class="audit">${html(JSON.stringify(report.network, null, 2))}</pre></details>` : ''}
      ${report.click ? `<details><summary>Pointer evidence</summary>
        <pre class="audit">${html(JSON.stringify(report.click, null, 2))}</pre>
        ${report.click.annotated ? `<img class="evidence-image" src="/api/board/evidence/${html(report.id)}/pointer" alt="Kane's highlighted browser target">` : ''}</details>` : ''}
      <p class="subtle">Local record ${html(report.id)}</p></div>` : '<p class="subtle">Choose Evidence on a completed scenario.</p>';
    content.innerHTML = `<div class="toolbar panel tool-row">
      <div><strong>Camera inspection gap</strong><div class="controls">
        <button data-action="rule" data-gap="0" ${model.gap === 0 ? 'disabled' : ''}>0 minutes</button>
        <button data-action="rule" data-gap="30" ${model.gap === 30 ? 'disabled' : ''}>30 minutes</button>
      </div></div><div><strong>${html(model.state)}</strong><br><small>${model.count} of ${cases.length} passed for this revision</small></div>
      <div class="controls"><button class="primary" data-action="run-all" ${model.running ? 'disabled' : ''}>Run all in Kane</button>
      <button data-action="approve" ${model.ready ? '' : 'disabled'}>Approve release</button></div>
      </div>
      <div class="layout">${panel('Kane evidence', evidence)}${panel('Verification scenarios', `<div class="table-wrap"><table><thead><tr><th scope="col">#</th><th scope="col">Scenario</th><th scope="col">Result</th><th scope="col">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`)}</div>`;
  }
  onClick(content, async (action, button) => {
    const id = Number(button.dataset.case);
    busy = true;
    try {
      if (action === 'demo') {
        const { id: run } = required(await api('/api/sessions', { number: id }));
        location.href = `/scenario?case=${id}&run=${run}`;
        return;
      }
      if (action === 'details' || action === 'archive') {
        selected = id;
        showingArchive = action === 'archive';
      }
      if (action === 'rule') required(await api('/api/board/rule', { gap: Number(button.dataset.gap) }));
      if (action === 'approve') required(await api('/api/board/approval', {}));
      if (action === 'run-all' || action === 'run-one') required(await api('/api/board/run', { cases: id ? [id] : undefined }));
    } finally {
      busy = false;
      await refresh();
    }
  });
  await refresh();
  setInterval(() => refresh().catch((error) => showError(error.message)), 2500);
}

const params = new URLSearchParams(location.search);
const scenario = cases.find(({ id }) => id === Number(params.get('case')));
let runId = params.get('run');

async function desk() {
  document.querySelector('#desk-link').setAttribute('aria-current', 'page');
  if (!runId) {
    ({ id: runId } = required(await api('/api/sessions', { number: scenario?.id ?? 0 })));
    const target = new URL(location.href);
    target.searchParams.set('run', runId);
    history.replaceState({}, '', target);
  }
  const key = `release-review:${runId}`;
  const recovered = JSON.parse(sessionStorage.getItem(key) ?? '{}');
  let user = recovered.user ?? 'Minji';
  let completed = recovered.completed ?? 0;
  const facts = new Map(recovered.facts ?? []);
  let state;
  let initialGap;
  let inventoryCache;
  let acting = false;
  let selected;

  const scenarioContent = scenario ? panel('Scenario actions',
    `<div class="case-steps">${scenario.steps.map(({ label }, index) =>
      `<button data-action="step" data-index="${index}">${html(label)}</button>`).join('')}</div>`) : '';
  app.innerHTML = heading(scenario ? `Scenario ${scenario.id} · ${scenario.title}` : 'Reservation desk',
    scenario?.focus ?? 'Book the camera, lens or complete kit. Reservations and waitlist updates share one schedule.') +
    `<p id="page-error" class="toast error" role="status"></p>
    <div class="panel toolbar tool-row"><label>Demo user<select id="demo-user">${people.map((entry) => `<option>${entry}</option>`).join('')}</select></label>
    <strong id="inspection-gap"></strong><button data-action="refresh">Refresh reservations</button></div>
    <div class="layout">
      <div class="stack">${scenarioContent}${scenario ? panel('Observed results', '<dl class="facts" id="facts"></dl>') : ''}
        <div id="dialog" hidden class="modal" role="dialog" aria-label="Cancel reservation confirmation"></div>
        ${panel('Book equipment', `<div class="form-launch" id="form-launch"><button class="primary" id="open-form" data-action="open-form">Open reservation form</button></div>
        <form id="reservation-form" class="stack" hidden>
          <h3 id="form-title">Reservation form</h3>
          <label>Equipment<select name="kind"><option>Camera</option><option>Lens</option><option>Kit</option></select></label>
          <div class="controls"><label>Start time<select name="start" required></select></label><label>End time<select name="end" required></select></label></div>
          <label>Queue when unavailable<select name="wait"><option value="false">No</option><option value="true">Yes</option></select></label>
          <div class="controls"><button class="primary" type="submit">Save reservation</button><button type="button" data-action="close-form">Close form</button></div>
        </form><p id="notice" class="toast" role="status"></p>`)}
      </div>
      <div class="stack">${panel('Reservations', '<div class="table-wrap" id="reservations"></div>')}
        ${panel('Inventory', '<div id="inventory"></div>')}</div>
    </div>`;
  const selector = document.querySelector('#demo-user');
  const form = document.querySelector('#reservation-form');
  const dialog = document.querySelector('#dialog');
  const launch = document.querySelector('#form-launch');
  const notice = document.querySelector('#notice');

  const endpoint = (suffix) => `/api/sessions/${runId}/${suffix}`;
  const remember = () => sessionStorage.setItem(key, JSON.stringify({ user, completed, facts: [...facts] }));
  function fact(label, value) {
    facts.set(label, value);
    renderFacts();
    remember();
  }
  function renderFacts() {
    if (scenario) document.querySelector('#facts').innerHTML = [...facts].map(([label, value]) =>
      `<div><dt>${html(label)}</dt><dd>${html(value)}</dd></div>`).join('');
  }
  function viewer(actor) {
    user = actor;
    selector.value = actor;
    remember();
    if (state) render();
  }
  function gapForDisplay() {
    return scenario && demoDefects.has(2) && scenario.id === 2 ? initialGap : state.gap;
  }
  function offered(kind, start, end, exclude = 0) {
    const includes = (selection, item) => selection === 'Kit' || selection === item;
    return !state.allocations.some((item) => {
      const padding = item.item === 'Camera' ? gapForDisplay() : 0;
      return item.bookingId !== exclude && includes(kind, item.item) && start < item.end + padding && item.start < end + padding;
    });
  }
  function paintForm() {
    const starts = form.elements.start;
    const ends = form.elements.end;
    const start = Number(starts.value || 600);
    const end = Number(ends.value || 660);
    starts.replaceChildren();
    ends.replaceChildren();
    for (let minutes = 540; minutes <= 1080; minutes += 15) {
      if (minutes < 1080) {
        const option = new Option(time(minutes), minutes);
        const unavailable = !offered(form.elements.kind.value, minutes, minutes + 15, Number(form.dataset.edit || 0));
        option.disabled = unavailable && form.elements.wait.value !== 'true' && !form.dataset.edit;
        starts.add(option);
      }
      if (minutes > 540) ends.add(new Option(time(minutes), minutes));
    }
    starts.value = String(start);
    ends.value = String(end);
  }
  function render() {
    document.querySelector('#inspection-gap').textContent = `Camera inspection gap: ${gapForDisplay()} minutes`;
    const bookings = state.bookings.map((item) => {
      const isOwner = item.actor === user;
      const cancel = isOwner && item.status !== 'Cancelled';
      const edit = isOwner && item.status === 'Confirmed';
      const restore = isOwner && item.status === 'Cancelled';
      return `<tr><td>${item.id}</td><td>${html(item.actor)}</td><td>${html(item.kind)}</td><td>${time(item.start)}–${time(item.end)}</td>
        <td>${badge(item.status)}</td><td class="actions">${cancel ? `<button data-action="cancel" data-id="${item.id}">Cancel</button>` : ''}
        ${edit ? `<button data-action="edit" data-id="${item.id}">Edit</button>` : ''}
        ${restore ? `<button data-action="restore" data-id="${item.id}">Restore</button>` : ''}</td></tr>`;
    }).join('');
    document.querySelector('#reservations').innerHTML = bookings ? `<table><thead><tr><th>ID</th><th>Owner</th><th>Equipment</th><th>Time</th><th>Status</th><th>Actions</th></tr></thead><tbody>${bookings}</tbody></table>` : '<p>No reservations yet.</p>';
    const source = scenario?.id === 4 && demoDefects.has(4) ? inventoryCache : state.allocations;
    const allocations = source.map((entry) =>
      `<tr><td>${html(entry.item)}</td><td>${html(entry.actor)}</td><td>${time(entry.start)}–${time(entry.end)}</td></tr>`).join('');
    document.querySelector('#inventory').innerHTML = allocations ? `<table><thead><tr><th>Equipment</th><th>Allocated to</th><th>Time</th></tr></thead><tbody>${allocations}</tbody></table>` : '<p>No equipment allocated.</p>';
    paintForm();
  }
  function apply(snapshot) {
    if (state && snapshot.revision < state.revision && !(scenario?.id === 10 && demoDefects.has(10))) return;
    initialGap ??= snapshot.gap;
    inventoryCache ??= snapshot.allocations;
    state = snapshot;
    render();
  }
  async function read(hold) {
    const data = required(await api(endpoint(hold ? 'state?hold=true' : 'state')));
    apply(data);
    return data;
  }
  function notify(message, isError = false) {
    notice.textContent = message;
    notice.classList.toggle('error', isError);
    return message;
  }
  function mutationMessage(operation, result) {
    if (operation === 'restore' && (result.code === 200 || (scenario?.id === 1 && demoDefects.has(1)))) {
      return notify('Reservation restored');
    }
    if (result.code >= 400) return notify(result.message, true);
    return notify(`Reservation ${String(result.item?.status ?? 'saved').toLowerCase()}.`);
  }
  async function mutate(operation, actor, input, options) {
    let result;
    try {
      result = await api(endpoint('mutation'), { operation, actor, input, ...options });
    } catch (error) {
      if (!options?.drop) throw error;
      result = { code: 'lost', message: 'Connection closed before response.' };
    }
    await read();
    return result;
  }
  function openConfirmation(item) {
    selected = { id: item.id, actor: item.actor, index: state.bookings.filter(({ status }) => status === 'Waiting').findIndex(({ id }) => id === item.id) };
    dialog.hidden = false;
    dialog.innerHTML = `<h3>Cancel ${html(item.actor)}'s reservation?</h3>
      <p>Reservation ${item.id} · ${html(item.kind)} · ${time(item.start)}–${time(item.end)}</p>
      <div class="controls"><button type="button" data-action="confirm">Confirm cancellation</button><button type="button" data-action="dismiss">Keep reservation</button></div>`;
    if (scenario?.id === 9) fact('Observed booking ID', item.id);
  }
  async function confirmCancellation() {
    if (!selected) throw new Error('Open a cancellation confirmation first.');
    const id = scenario?.id === 9 && demoDefects.has(9)
      ? state.bookings.filter(({ status }) => status === 'Waiting')[selected.index]?.id : selected.id;
    const result = await mutate('cancel', selected.actor, { id });
    selected = undefined;
    dialog.hidden = true;
    mutationMessage('cancel', result);
    return result;
  }
  function editForm(item) {
    form.hidden = false;
    form.dataset.edit = item?.id ?? '';
    document.querySelector('#form-title').textContent = item ? 'Change reservation time' : 'Reservation form';
    form.elements.kind.disabled = Boolean(item);
    form.elements.wait.disabled = Boolean(item);
    form.elements.kind.value = item?.kind ?? 'Camera';
    if (item) {
      form.elements.start.value = item.start;
      form.elements.end.value = item.end;
    }
    paintForm();
  }

  function showOverlay() {
    launch.querySelector('.overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'overlay reduced';
    overlay.setAttribute('aria-label', 'Inspection notification overlay');
    overlay.innerHTML = '<strong>Inspection notice</strong> <button data-action="close-overlay">Dismiss notice</button>';
    launch.append(overlay);
  }
  function closeOverlay() {
    const overlay = launch.querySelector('.overlay');
    if (!overlay) return;
    if (scenario?.id === 11 && demoDefects.has(11)) {
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      overlay.classList.add('closed');
    } else {
      overlay.remove();
    }
  }
  function pointerTarget() {
    const button = document.querySelector('#open-form');
    const location = button.getBoundingClientRect();
    const target = document.elementFromPoint(location.left + location.width / 2, location.top + location.height / 2);
    if (target?.closest('#open-form')) return 'Open reservation form';
    return target?.closest('.overlay')?.getAttribute('aria-label') ?? 'Target outside viewport';
  }
  const driver = {
    mutate, read, fact, viewer, openConfirmation, confirmCancellation, showOverlay, closeOverlay, pointerTarget,
    memo: {},
    snapshot: () => state,
    offered,
    mutationMessage,
    gap: async (gap) => apply(required(await api(endpoint('rule'), { gap }))),
    reset: async () => {
      state = undefined;
      inventoryCache = undefined;
      initialGap = undefined;
      apply(required(await api(endpoint('reset'), {})));
    },
    untilHeld: async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        if ((await api(endpoint('held'))).held) return;
        await new Promise((done) => setTimeout(done, 50));
      }
      throw new Error('The old request did not reach the hold point.');
    },
    release: () => api(endpoint('release'), {}),
    permission: () => api(endpoint('permission'), {}),
  };
  function updateSteps() {
    for (const button of app.querySelectorAll('[data-index]')) {
      const index = Number(button.dataset.index);
      button.disabled = acting || index !== completed;
      if (index < completed) button.textContent = `${scenario.steps[index].label} ✓`;
    }
  }
  onClick(app, async (action, button) => {
    const id = Number(button.dataset.id);
    const item = state?.bookings.find((entry) => entry.id === id);
    if (action === 'step') {
      acting = true;
      updateSteps();
      try {
        await scenario.steps[completed].action(driver);
        completed++;
        remember();
      } finally {
        acting = false;
        updateSteps();
      }
    }
    if (action === 'refresh') await read();
    if (action === 'open-form') editForm();
    if (action === 'close-form') form.hidden = true;
    if (action === 'edit' && item) editForm(item);
    if (action === 'cancel' && item) openConfirmation(item);
    if (action === 'restore' && item) mutationMessage('restore', await mutate('restore', user, { id }));
    if (action === 'confirm') await confirmCancellation();
    if (action === 'dismiss') { selected = undefined; dialog.hidden = true; }
    if (action === 'close-overlay') closeOverlay();
  });
  selector.addEventListener('change', () => viewer(selector.value));
  form.addEventListener('change', () => paintForm());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const { kind, wait, start, end } = form.elements;
    const editing = Number(form.dataset.edit);
    const action = editing ? 'edit' : 'create';
    const result = await mutate(action, user, editing ? { id: editing, start: Number(start.value), end: Number(end.value) }
      : { kind: kind.value, start: Number(start.value), end: Number(end.value), wait: wait.value === 'true' },
    { key: crypto.randomUUID() });
    mutationMessage(action, result);
    if (result.code < 400) form.hidden = true;
  });
  viewer(user);
  renderFacts();
  updateSteps();
  await read();
  if (!scenario) setInterval(() => read().catch((error) => showError(error.message)), 2000);
}

const page = location.pathname === '/' ? dashboard : desk;
page().catch((error) => showError(error.message));
