import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Reservations, Problem } from './domain.mjs';
import { cases } from '../public/cases.js';
import { VerificationBoard } from './verification.mjs';

const publicRoot = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/desk', ['index.html', 'text/html']],
  ['/scenario', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/cases.js', ['cases.js', 'text/javascript']],
  ['/defects.js', ['defects.js', 'text/javascript']],
]);

class DeskRun {
  constructor(base, scenario) {
    this.base = base;
    this.scenario = scenario;
    this.sequence = 0;
    this.reset(0);
  }

  reset(gap) {
    this.reservations?.close();
    this.reservations = new Reservations(`${this.base}-${this.sequence++}.sqlite`, this.scenario?.fixture ?? [], gap);
    this.events = [];
    this.groups = new Map();
    this.held = null;
  }

  record(event) {
    this.events.push({ sequence: this.events.length + 1, ...event });
  }

  order(group, order) {
    return new Promise((done, fail) => {
      let batch = this.groups.get(group);
      if (!batch) {
        batch = { members: [], timeout: setTimeout(() => {
          this.groups.delete(group);
          for (const member of batch.members) member.fail(new Problem(408, 'The paired request did not arrive.'));
        }, 5000) };
        this.groups.set(group, batch);
      }
      batch.members.push({ done, fail, order });
      if (batch.members.length === 2) {
        this.groups.delete(group);
        clearTimeout(batch.timeout);
        for (const member of batch.members.sort((a, b) => a.order - b.order)) member.done();
      }
    });
  }

  async hold(snapshot) {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.held = null;
        fail(new Problem(408, 'The held response was not released.'));
      }, 90_000);
      this.held = () => {
        clearTimeout(timer);
        this.held = null;
        done();
      };
    });
    return snapshot;
  }
}

function send(res, status, payload) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let input = '';
  for await (const block of req) {
    input += block;
    if (input.length > 8192) throw new Problem(413, 'Request is too large.');
  }
  try {
    return JSON.parse(input || '{}');
  } catch {
    throw new Problem(400, 'Invalid JSON.');
  }
}

export function createApplication({ data = resolve('.local'), boardEnabled = true } = {}) {
  const runPath = join(data, 'runs');
  mkdirSync(runPath, { recursive: true });
  const runs = new Map();
  const createRun = (number, gap) => {
    const scenario = cases.find(({ id }) => id === number);
    if (number !== 0 && !scenario) throw new Problem(404, 'Unknown scenario.');
    const id = randomUUID();
    const run = new DeskRun(join(runPath, id), scenario, gap);
    if (gap === 30) run.reservations.setGap(30);
    runs.set(id, run);
    return { id, run };
  };

  const board = boardEnabled ? new VerificationBoard({ data, createRun }) : null;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (req.method === 'GET' && assets.has(route)) {
        const [file, type] = assets.get(route);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        return res.end(readFileSync(new URL(file, publicRoot)));
      }
      if (route === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true });
      if (route.startsWith('/api/board') && board) {
        if (req.method === 'GET') {
          if (route === '/api/board') return send(res, 200, board.view());
          const png = /^\/api\/board\/evidence\/([a-z0-9-]+)$/.exec(route)?.[1];
          if (png) {
            const bytes = board.screenshot(png);
            if (bytes) {
              res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
              return res.end(bytes);
            }
          }
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (route === '/api/board/rule') return send(res, 200, board.setRule(body.gap));
          if (route === '/api/board/run') return send(res, 202, board.start(body.cases, server.address().port));
          if (route === '/api/board/approval') return send(res, 200, board.approve());
          if (route === '/api/board/code-feedback') return send(res, 200, board.feedback(body.id));
        }
      }
      if (route === '/api/sessions' && req.method === 'POST') {
        const { number = 0 } = await readBody(req);
        const { id } = createRun(number, board?.gap ?? 0);
        return send(res, 201, { id });
      }
      const matches = /^\/api\/sessions\/([a-f0-9-]+)\/(state|rule|reset|mutation|held|release|permission)$/.exec(route);
      if (!matches) throw new Problem(404, 'Page not found.');
      const [, id, action] = matches;
      const run = runs.get(id);
      if (!run) throw new Problem(404, 'This local session has expired. Start a new one.');
      if (action === 'state' && req.method === 'GET') {
        const snapshot = run.reservations.getState();
        if (!run.scenario && board && snapshot.gap !== board.gap) {
          return send(res, 200, run.reservations.setGap(board.gap));
        }
        if (run.scenario?.id === 10 && url.searchParams.get('hold') === 'true') {
          if (run.held) throw new Problem(409, 'A response is already held.');
          run.record({ type: 'read-held', revision: snapshot.revision });
          await run.hold(snapshot);
          run.record({ type: 'read-delivered', revision: snapshot.revision });
        } else {
          run.record({ type: 'read-delivered', revision: snapshot.revision });
        }
        return send(res, 200, snapshot);
      }
      if (action === 'held' && req.method === 'GET' && run.scenario?.id === 10) {
        return send(res, 200, { held: Boolean(run.held) });
      }
      if (req.method !== 'POST') throw new Problem(405, 'Method not available.');
      const body = await readBody(req);
      if (action === 'rule' && run.scenario) return send(res, 200, run.reservations.setGap(body.gap));
      if (action === 'reset' && run.scenario) {
        run.reset(0);
        return send(res, 200, run.reservations.getState());
      }
      if (action === 'release' && run.scenario?.id === 10) {
        run.held?.();
        return send(res, 200, { ok: true });
      }
      if (action === 'permission' && run.scenario?.id === 12) {
        run.reservations.requireOwner('Junho', 1);
        return send(res, 200, { allowed: true });
      }
      if (action !== 'mutation') throw new Problem(404, 'Action not available.');
      const { actor, operation, input = {}, key, group, order, drop } = body;
      const trace = { type: 'mutation', actor, operation, key, order, group };
      run.record({ ...trace, phase: 'arrived' });
      const validGroup = { 5: 'race', 6: 'duplicate', 8: 'cancel-race' }[run.scenario?.id];
      if (group && group === validGroup && [0, 1].includes(order)) await run.order(group, order);
      if (!run.scenario && board) run.reservations.setGap(board.gap);
      try {
        const result = run.reservations.mutate(actor, operation, input, key);
        run.record({ ...trace, phase: 'committed', code: result.code, bookingId: result.item.id, replayed: result.replayed });
        if (drop && run.scenario?.id === 7) return res.destroy();
        return send(res, result.code, result);
      } catch (error) {
        run.record({ ...trace, phase: 'rejected', code: error.status });
        throw error;
      }
    } catch (error) {
      if (!(error instanceof Problem)) console.error(error);
      send(res, error.status ?? 500, { message: error.status ? error.message : 'Unexpected server error.' });
    }
  });
  return { server, createRun, board };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 4173);
  const app = createApplication();
  app.server.listen(port, '127.0.0.1', () => console.log(`Release Review · http://127.0.0.1:${app.server.address().port}`));
}
