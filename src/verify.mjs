const target = process.env.RELEASE_REVIEW_URL ?? 'http://127.0.0.1:4173';
const cases = process.argv.slice(2).map(Number);
const request = await fetch(new URL('/api/board/run', target), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cases: cases.length ? cases : undefined }),
});
if (!request.ok) throw new Error((await request.json()).message);
let last = '';
for (;;) {
  const response = await fetch(new URL('/api/board', target));
  if (!response.ok) throw new Error('Could not read the verification board.');
  const board = await response.json();
  const current = Object.values(board.results).map(({ case: id, status, reason }) => `${id} ${status} · ${reason}`).join('\n');
  if (current !== last) console.log(current);
  last = current;
  if (!board.running) {
    const selected = cases.length ? cases : Array.from({ length: 12 }, (_, index) => index + 1);
    process.exitCode = selected.every((id) => board.results[id]?.status === 'Passed') ? 0 : 1;
    break;
  }
  await new Promise((done) => setTimeout(done, 2500));
}
