const at = (h, m = 0) => h * 60 + m;
export const time = (minutes) => [Math.floor(minutes / 60), minutes % 60].map((n) => String(n).padStart(2, '0')).join(':');
const slot = (kind, start, end, wait = false) => ({ kind, start, end, wait });
const row = (actor, kind, start, end, status = 'Confirmed', cancelledFrom) => ({ actor, kind, start, end, status, cancelledFrom });
const ten = at(10);
const noon = at(12);
const half = at(12, 30);
const one = at(13);
const halfOne = at(13, 30);
const two = at(14);
const four = at(16);
const camera = row('Minji', 'Camera', ten, noon);
const kit = slot('Kit', half, halfOne, true);
const heldKit = row('Minji', 'Kit', half, halfOne);
const waiting = (actor) => row(actor, 'Kit', half, halfOne, 'Waiting');
const names = (state, status) => state.bookings.filter((booking) => booking.status === status).map(({ actor }) => actor).join(', ') || 'none';
const number = (state, status) => state.bookings.filter((booking) => booking.status === status).length;
const booking = (state, id) => state.bookings.find((item) => item.id === id);
const slotText = (item) => item ? `${time(item.start)}–${time(item.end)}` : 'none';
const step = (label, action, expects) => ({ label, action, expects });
const creation = (actor, values, options) => ['create', actor, values, options];
const cancellation = (actor, id, options) => ['cancel', actor, { id }, options];
const show = (d, title, value) => d.fact(title, String(value));

export const cases = [
  {
    id: 1, title: 'Restore conflict', focus: 'A rejected restore must never show a success notification.',
    fixture: [camera],
    steps: [
      step('Cancel Minji and book for Junho', async (d) => {
        await d.mutate(...cancellation('Minji', 1));
        await d.mutate(...creation('Junho', slot('Camera', ten, noon)));
      }, 'Verify the Reservations table shows Minji Cancelled and Junho Confirmed.'),
      step('Try restoring Minji', async (d) => {
        const result = await d.mutate('restore', 'Minji', { id: 1 });
        show(d, 'Restore response', result.code);
        show(d, 'Customer notification', d.mutationMessage('restore', result));
      }, 'Verify Restore response is 409 and Customer notification says Restore blocked because the original slot is unavailable. Verify there is no Reservation restored notification.'),
      step('Reload stored reservations', async (d) => {
        const state = await d.read();
        show(d, 'Confirmed owners after reload', names(state, 'Confirmed'));
      }, 'Reload the browser page and verify Junho is the only Confirmed booking and Minji is Cancelled.'),
    ],
  },
  {
    id: 2, title: 'Live policy and time edits', focus: 'A rule update reaches a page that is already open.',
    fixture: [camera],
    steps: [
      step('Reserve the touching slot at zero minutes', async (d) => {
        const result = await d.mutate(...creation('Junho', slot('Camera', noon, one)));
        show(d, 'At zero minutes', result.item?.status ?? result.message);
        if (result.item) await d.mutate(...cancellation('Junho', result.item.id));
      }, 'Verify At zero minutes is Confirmed.'),
      step('Switch inspection to 30 minutes', async (d) => {
        await d.gap(30);
        await d.read();
        show(d, '12:00 start option', d.offered('Camera', noon, one) ? 'Available' : 'Unavailable');
        show(d, '12:30 start option', d.offered('Camera', half, halfOne) ? 'Available' : 'Unavailable');
      }, 'Without reloading, verify 12:00 start option is Unavailable and 12:30 start option is Available.'),
      step('Try both boundary starts', async (d) => {
        const early = await d.mutate(...creation('Junho', slot('Camera', noon, one)));
        const allowed = await d.mutate(...creation('Junho', slot('Camera', half, halfOne)));
        show(d, '12:00 response', early.code);
        show(d, '12:30 response', allowed.item?.status ?? allowed.message);
        d.memo.id = allowed.item?.id;
      }, 'Verify 12:00 response is 409 and 12:30 response is Confirmed.'),
      step('Try editing into the overlap', async (d) => {
        const result = await d.mutate('edit', 'Junho', { id: d.memo.id, start: at(11, 30), end: half });
        show(d, 'Edit response', result.code);
        show(d, 'Junho saved time', slotText(booking(await d.read(), d.memo.id)));
      }, 'Verify Edit response is 409 and Junho saved time is 12:30–13:30.'),
    ],
  },
  {
    id: 3, title: 'Restore after the slot opens', focus: 'A valid restore keeps the original booking ID.',
    fixture: [row('Minji', 'Camera', ten, noon, 'Cancelled', 'Confirmed'), row('Junho', 'Camera', ten, noon)],
    steps: [
      step('Free the original slot', async (d) => {
        await d.mutate(...cancellation('Junho', 2));
        show(d, 'Confirmed count before restore', number(await d.read(), 'Confirmed'));
      }, 'Verify Confirmed count before restore is 0.'),
      step('Restore Minji', async (d) => {
        const response = await d.mutate('restore', 'Minji', { id: 1 });
        show(d, 'Observed booking ID', response.item?.id ?? 'none');
        show(d, 'Observed booking status', response.item?.status ?? response.message);
        show(d, 'Confirmed count after restore', number(await d.read(), 'Confirmed'));
      }, 'Verify Observed booking ID is 1, Observed booking status is Confirmed and Confirmed count after restore is 1. Store the displayed ID as booking_id and the displayed status as booking_status.'),
    ],
  },
  {
    id: 4, title: 'Whole-kit queue and inspection', focus: 'Reservation and inventory views must agree after each promotion.', visual: true,
    fixture: [row('Minji', 'Camera', at(10, 30), half), row('Sora', 'Lens', half, halfOne), waiting('Junho'), waiting('Yuna')],
    steps: [
      step('Cancel the lens at zero minutes', async (d) => {
        await d.gap(0);
        await d.mutate(...cancellation('Sora', 2));
        await inventory(d, 'Zero-minute owner');
      }, 'Verify Zero-minute owner is Junho and in the Inventory panel Junho has both the Camera and Lens for 12:30–13:30.'),
      step('Reset and cancel the lens at 30 minutes', async (d) => {
        await d.reset();
        await d.gap(30);
        await d.mutate(...cancellation('Sora', 2));
        const state = await d.read();
        show(d, 'Waiting owners at 30 minutes', names(state, 'Waiting'));
        show(d, 'Lens owner at 12:30', state.allocations.find((item) => item.item === 'Lens' && item.start === half)?.actor ?? 'none');
      }, 'Verify Waiting owners at 30 minutes are Junho, Yuna. Verify Lens owner at 12:30 is none and the Inventory panel shows no Lens allocation.'),
      step('Cancel the camera to promote the kit', async (d) => {
        await d.mutate(...cancellation('Minji', 1));
        await inventory(d, 'Thirty-minute owner');
      }, 'Verify only Junho is Confirmed, Yuna is Waiting and the Inventory panel visibly shows both Camera and Lens assigned to Junho.'),
    ],
  },
  {
    id: 5, title: 'Two users, one remaining kit', focus: 'Two separate requests reach the server before either is handled.',
    fixture: [],
    steps: [
      step('Send both booking requests together', async (d) => {
        await Promise.all(['Junho', 'Yuna'].map((actor, order) => d.mutate(...creation(actor, kit, { group: 'race', order }))));
        await counts(d, 'Concurrent');
      }, 'Verify Concurrent confirmed is 1, Concurrent waiting is 1 and Concurrent allocations is 2.'),
      step('Reload race results', async (d) => {
        await counts(d, 'Persisted');
      }, 'Reload the page and verify one booking is Confirmed, one is Waiting, and only the confirmed owner appears for both equipment allocations.'),
    ],
  },
  {
    id: 6, title: 'Duplicate requests and idempotency', focus: 'Replay receipts are transactionally bound to a single booking.',
    fixture: [],
    steps: [
      step('Send identical requests in parallel', async (d) => {
        const results = await Promise.all([0, 1].map((order) => d.mutate(...creation('Junho', kit, { key: 'same-key', group: 'duplicate', order }))));
        d.memo.id = results[0].item?.id;
        show(d, 'Parallel response IDs', results.map((result) => result.item?.id ?? 'none').join(', '));
      }, 'Verify Parallel response IDs is 1, 1.'),
      step('Replay and change the request', async (d) => {
        const replay = await d.mutate(...creation('Junho', kit, { key: 'same-key' }));
        const conflict = await d.mutate(...creation('Junho', { ...kit, start: one }, { key: 'same-key' }));
        const duplicate = await d.mutate(...creation('Junho', kit, { key: 'different-key' }));
        show(d, 'Replay ID', replay.item?.id ?? 'none');
        show(d, 'Changed request response', conflict.code);
        show(d, 'New-key duplicate ID', duplicate.item?.id ?? 'none');
        show(d, 'Active reservations', (await d.read()).bookings.filter(({ status }) => status !== 'Cancelled').length);
      }, 'Verify Replay ID is 1, Changed request response is 409, New-key duplicate ID is 1 and Active reservations is 1.'),
      step('Retry a cancellation', async (d) => {
        const first = await d.mutate(...cancellation('Junho', d.memo.id, { key: 'cancel-receipt' }));
        const retry = await d.mutate(...cancellation('Junho', d.memo.id, { key: 'cancel-receipt' }));
        show(d, 'Cancellation replay', first.item?.id === retry.item?.id && retry.replayed ? 'Same receipt' : 'Different receipt');
      }, 'Verify Cancellation replay is Same receipt.'),
    ],
  },
  {
    id: 7, title: 'Response lost before a promotion', focus: 'A replay receipt must not overwrite the current booking.',
    fixture: [heldKit],
    steps: [
      step('Submit and lose the first response', async (d) => {
        const result = await d.mutate(...creation('Junho', kit, { key: 'lost-response', drop: true }));
        show(d, 'Browser received', result.code === 'lost' ? 'Connection closed before response' : result.code);
      }, 'Verify Browser received is Connection closed before response and Junho has a Waiting reservation.'),
      step('Free the kit and retry', async (d) => {
        await d.mutate(...cancellation('Minji', 1));
        const replay = await d.mutate(...creation('Junho', kit, { key: 'lost-response' }));
        show(d, 'Original receipt status', replay.item?.status ?? 'none');
        const state = await d.read();
        show(d, 'Observed booking ID', replay.item?.id ?? 'none');
        show(d, 'Observed booking status', booking(state, replay.item?.id)?.status ?? 'none');
        show(d, 'Live allocations', state.allocations.length);
      }, 'Verify Original receipt status is Waiting, Observed booking ID is 2, Observed booking status is Confirmed and Live allocations is 2. Store the displayed ID as booking_id and the displayed status as booking_status.'),
    ],
  },
  {
    id: 8, title: 'Cancel versus queue promotion', focus: 'Both request orders end with the same equipment owner.',
    fixture: [heldKit, waiting('Junho'), waiting('Yuna')],
    steps: [
      step('Race release first', async (d) => {
        await cancelRace(d, 0);
        await raceState(d, 'Release first');
      }, 'Verify Release first result is Junho Cancelled, Yuna Confirmed, 2 allocations.'),
      step('Reset and race withdrawal first', async (d) => {
        await d.reset();
        await cancelRace(d, 1);
        await raceState(d, 'Withdrawal first');
      }, 'Verify Withdrawal first result is Junho Cancelled, Yuna Confirmed, 2 allocations.'),
    ],
  },
  {
    id: 9, title: 'Open confirmation, moving queue', focus: 'A confirmation dialog acts on a stable reservation ID.',
    fixture: [heldKit, waiting('Junho'), waiting('Yuna'), waiting('Jimin')],
    steps: [
      step('Open Yuna cancellation confirmation', async (d) => {
        const state = await d.read();
        d.openConfirmation(booking(state, 3));
      }, 'Verify the visible confirmation names Yuna and identifies booking 3. Store the displayed Observed booking ID as booking_id.'),
      step('Promote Junho while the dialog is open', async (d) => {
        await d.mutate(...cancellation('Minji', 1));
        show(d, 'Waiting owners after promotion', names(await d.read(), 'Waiting'));
      }, 'Verify Waiting owners after promotion says Yuna, Jimin and the confirmation still names Yuna.'),
      step('Confirm Yuna cancellation', async (d) => {
        const result = await d.confirmCancellation();
        const state = await d.read();
        show(d, 'Cancellation response', result.code);
        show(d, 'Observed booking status', booking(state, 3).status);
        show(d, 'Jimin status', booking(state, 4).status);
        show(d, 'Junho status', booking(state, 2).status);
      }, 'Verify Cancellation response is 200, Observed booking status is Cancelled, Jimin status is Waiting, and Junho status is Confirmed. Store Observed booking status as booking_status.'),
    ],
  },
  {
    id: 10, title: 'Old browser response arrives late', focus: 'A newer reservation revision stays on screen.',
    fixture: [heldKit, waiting('Junho')],
    steps: [
      step('Start and hold the old lookup', async (d) => {
        d.memo.old = d.read('hold');
        await d.untilHeld();
        show(d, 'Old lookup', 'Waiting response held');
      }, 'Verify Old lookup is Waiting response held.'),
      step('Promote Junho and display the new lookup', async (d) => {
        await d.mutate(...cancellation('Minji', 1));
        show(d, 'Before releasing old lookup', booking(await d.read(), 2).status);
      }, 'Verify Before releasing old lookup is Confirmed.'),
      step('Deliver the old lookup', async (d) => {
        await d.release();
        const old = await d.memo.old;
        show(d, 'Late response status', booking(old, 2).status);
        show(d, 'Rendered status afterward', booking(d.snapshot(), 2).status);
      }, 'Verify Late response status is Waiting but Rendered status afterward is Confirmed, and the Reservations table still shows Junho Confirmed.'),
    ],
  },
  {
    id: 11, title: 'Invisible overlay with reduced motion', focus: 'Closing a notification restores pointer access.', visual: true,
    fixture: [],
    steps: [
      step('Show reduced-motion notification', async (d) => {
        d.showOverlay();
      }, 'Verify Inspection notice is visible.'),
      step('Close the notification', async (d) => {
        d.closeOverlay();
        show(d, 'Actual pointer target', d.pointerTarget());
      }, 'Verify Actual pointer target says Open reservation form.'),
    ],
    final: 'Click the Open reservation form button and visually verify that the Reservation form panel opens.',
  },
  {
    id: 12, title: 'Reservation ownership protection', focus: 'The owner keeps the reservation and the observer has no edit or cancel control.',
    fixture: [camera],
    steps: [
      step('View Minji reservation as Junho', async (d) => {
        d.viewer('Junho');
        const state = await d.read();
        show(d, 'Observed booking ID', state.bookings[0].id);
        show(d, 'Displayed owner', state.bookings[0].actor);
      }, 'Verify Displayed owner is Minji. In the Reservations table verify no Cancel, Edit or Restore action is visible for Minji. Store Observed booking ID as booking_id.'),
      step('Verify cancellation permission', async (d) => {
        const denial = await d.permission();
        show(d, 'Permission check', denial.code);
        show(d, 'Observed booking status', (await d.read()).bookings[0].status);
      }, 'Verify Permission check is 403 and Observed booking status is Confirmed. Store Observed booking status as booking_status.'),
      step('Return to the owner view', async (d) => {
        d.viewer('Minji');
        await d.read();
      }, 'Reload the page and verify Minji is still Confirmed and the owner can see their Cancel control.'),
    ],
  },
];

async function inventory(d, label) {
  const state = await d.read();
  show(d, label, state.allocations.find((item) => item.item === 'Lens' && item.start === half)?.actor ?? 'none');
}

async function counts(d, label) {
  const state = await d.read();
  show(d, `${label} confirmed`, number(state, 'Confirmed'));
  show(d, `${label} waiting`, number(state, 'Waiting'));
  show(d, `${label} allocations`, state.allocations.length);
}

async function cancelRace(d, releaseOrder) {
  await Promise.all([
    d.mutate(...cancellation('Minji', 1, { group: 'cancel-race', order: releaseOrder })),
    d.mutate(...cancellation('Junho', 2, { group: 'cancel-race', order: 1 - releaseOrder })),
  ]);
}

async function raceState(d, label) {
  const state = await d.read();
  show(d, `${label} result`, `Junho ${booking(state, 2).status}, Yuna ${booking(state, 3).status}, ${state.allocations.length} allocations`);
}

export function objective(scenario) {
  const steps = scenario.steps.map(({ label, expects }) => `Click "${label}" and wait for the action to finish. ${expects}`);
  const final = scenario.final ? [scenario.final] : [];
  return ['Verify this equipment reservation scenario in the visible browser UI. Use the scenario controls in order.', ...steps, ...final].join('\n');
}
