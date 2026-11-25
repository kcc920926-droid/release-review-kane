import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cases, objective } from '../public/cases.js';
import { Problem } from './domain.mjs';

const root = new URL('../', import.meta.url);
const sourceFiles = ['src/domain.mjs', 'src/server.mjs', 'src/verification.mjs', 'public/app.js',
  'public/index.html', 'public/style.css', 'public/cases.js', 'public/defects.js'];
const digest = () => createHash('sha256').update(sourceFiles.map((name) => readFileSync(new URL(name, root), 'utf8')).join('\0')).digest('hex');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const boardFiles = 'verification';
const discrepancyCases = new Set([3, 7, 9, 12]);

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
}

function writeJson(file, value) {
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, file);
}

function launch(command, args, cwd, budget) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, budget);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ code: 2, stdout, stderr: stderr + error.message, events: [] });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const events = stdout.split('\n').filter((line) => line.startsWith('{')).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      done({ code: timedOut ? 3 : code, stdout, stderr, events, end: events.findLast(({ type }) => type === 'run_end') });
    });
  });
}

function chromePath() {
  if (process.env.KANE_CLI_CHROME_PATH) return process.env.KANE_CLI_CHROME_PATH;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return ['google-chrome', 'chromium', 'chromium-browser'].find((name) => spawnSync('which', [name]).status === 0) ?? 'google-chrome';
}

async function withChrome(action) {
  const profile = mkdtempSync(join(tmpdir(), 'release-review-'));
  const browser = spawn(chromePath(), [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    '--force-prefers-reduced-motion', '--window-size=1440,1050', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let spawnError;
  browser.on('error', (error) => { spawnError = error; });
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    for (let count = 0; count < 80; count++) {
      if (spawnError) throw spawnError;
      if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
        if (port) return await action(`http://127.0.0.1:${port}`);
      }
      await wait(100);
    }
    throw new Error('Chrome did not publish a DevTools port.');
  } finally {
    browser.kill('SIGTERM');
    for (let count = 0; browser.exitCode === null && browser.signalCode === null && !spawnError && count < 20; count++) {
      await wait(50);
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

function unpack(path, args, limit = 12 * 1024 * 1024) {
  const result = spawnSync('unzip', [...args.slice(0, 1), path, ...args.slice(1)], { maxBuffer: limit });
  return result.status === 0 ? result.stdout : undefined;
}

function summarizeHar(archive, files) {
  const network = [];
  for (const file of files.filter((name) => name.endsWith('-network.har'))) {
    const bytes = unpack(archive, ['-p', file]);
    if (!bytes) continue;
    let entries;
    try { entries = JSON.parse(bytes).log.entries; } catch { continue; }
    for (const entry of entries) {
      const address = new URL(entry.request.url);
      if (address.hostname !== '127.0.0.1' || !address.pathname.startsWith('/api/sessions/')) continue;
      let request = {};
      try { request = JSON.parse(entry.request.postData?.text ?? '{}'); } catch { /* No JSON body. */ }
      network.push({ started: entry.startedDateTime, durationMs: entry.time, method: entry.request.method,
        action: request.operation ?? address.pathname.split('/').at(-1), key: request.key, status: entry.response.status });
    }
  }
  return network.sort((a, b) => Date.parse(a.started) + a.durationMs - Date.parse(b.started) - b.durationMs).slice(-25);
}

function copyEvidence(attempt, folder) {
  const hinted = attempt.events.findLast(({ pack }) => typeof pack === 'string')?.pack;
  const session = attempt.end?.session_dir ? join(attempt.end.session_dir, 'evidence') : null;
  const file = session && existsSync(session) ? readdirSync(session).find((name) => name.endsWith('.evidence')) : null;
  const archive = hinted && existsSync(hinted) ? hinted : file && join(session, file);
  if (!archive) return {};
  const names = unpack(archive, ['-Z1'])?.toString().split('\n') ?? [];
  const failure = names.find((name) => name.endsWith('/failure.yaml'));
  const step = failure?.slice(0, -'failure.yaml'.length);
  const candidates = names.filter((name) => name.endsWith('/annotated.png') || name.endsWith('/screenshot.png'));
  const screenshotFile = (step && candidates.find((name) => name === step + 'annotated.png')) ??
    (step && candidates.find((name) => name === step + 'screenshot.png')) ??
    candidates.at(-1);
  const bytes = screenshotFile ? unpack(archive, ['-p', screenshotFile]) : undefined;
  if (bytes) writeFileSync(join(folder, 'browser.png'), bytes);
  const failureText = failure ? unpack(archive, ['-p', failure]) : undefined;
  if (failureText) writeFileSync(join(folder, 'failure.yaml'), failureText);
  const clickStep = screenshotFile?.replace(/(?:annotated|screenshot)\.png$/, 'step.json');
  let click;
  if (clickStep) {
    try {
      const metadata = JSON.parse(unpack(archive, ['-p', clickStep])?.toString() ?? '{}');
      const coordinates = metadata.click_coordinates ?? metadata.click_point ?? metadata.click;
      if (coordinates) click = coordinates;
    } catch { /* An assertion step may not have pointer metadata. */ }
  }
  return { screenshot: Boolean(bytes), archive, click, network: summarizeHar(archive, names), failure: Boolean(failureText) };
}

function compareState(scenario, observed, state) {
  if (!discrepancyCases.has(scenario.id)) return [];
  const targetId = { 3: 1, 7: 2, 9: 3, 12: 1 }[scenario.id];
  const expected = state.bookings.find(({ id }) => id === targetId);
  return [['booking_id', expected?.id, observed?.booking_id], ['booking_status', expected?.status, observed?.booking_status]]
    .map(([field, value, display]) => ({ field, expected: String(value), observed: display == null ? 'Not captured' : String(display),
      match: display != null && String(display).trim().toLowerCase() === String(value).toLowerCase() }));
}

function invariants(scenario, state) {
  const confirmed = state.bookings.filter(({ status }) => status === 'Confirmed').length;
  const allocations = state.allocations.length;
  if (scenario.id === 11) return ['The Reservation form panel is open and the Inspection notice is not visible.'];
  return [
    `The Reservations table contains exactly ${confirmed} rows whose current status is Confirmed.`,
    `The Inventory panel lists exactly ${allocations} equipment allocations.`,
  ];
}

export class VerificationBoard {
  constructor({ data, createRun }) {
    this.directory = join(data, boardFiles);
    mkdirSync(this.directory, { recursive: true });
    this.file = join(this.directory, 'board.json');
    this.current = readJson(this.file, { gap: 0, approval: null, results: {} });
    this.createRun = createRun;
    this.version = digest();
    this.running = new Set();
  }

  get gap() { return this.current.gap; }
  get signature() { return `${this.version}:${this.gap}`; }

  save() { writeJson(this.file, this.current); }

  view() {
    const results = Object.fromEntries(Object.entries(this.current.results)
      .filter(([, result]) => result.signature === this.signature));
    const count = Object.values(results).filter(({ status }) => status === 'Passed').length;
    const ready = count === cases.length && !this.running.size && digest() === this.version;
    const state = this.running.size ? 'Verification running'
      : ready ? (this.current.approval === this.signature ? 'Approved' : 'Ready for approval') : 'Needs verification';
    return { gap: this.gap, version: this.version, results, count, ready, state, running: Boolean(this.running.size), runningCases: [...this.running] };
  }

  setRule(gap) {
    if (![0, 30].includes(gap)) throw new Problem(400, 'Choose a 0 or 30 minute inspection gap.');
    if (gap !== this.gap) {
      this.current.gap = gap;
      this.current.approval = null;
      this.current.results = {};
      this.save();
    }
    return this.view();
  }

  approve() {
    if (!this.view().ready) throw new Problem(409, 'Run all required checks for the current rule and code first.');
    this.current.approval = this.signature;
    this.save();
    return this.view();
  }

  screenshot(id) {
    const path = join(this.directory, id, 'browser.png');
    return existsSync(path) ? readFileSync(path) : null;
  }

  feedback(id) {
    if (!/^[a-z0-9-]+$/.test(id ?? '')) throw new Problem(400, 'Choose a verification record.');
    const file = join(this.directory, id, 'codex.json');
    if (!existsSync(file)) throw new Problem(404, 'No product failure report for that run.');
    return readJson(file, null);
  }

  start(selection, port) {
    if (this.running.size) throw new Problem(409, 'Verification is already running.');
    if (digest() !== this.version) throw new Problem(409, 'The application source changed. Restart the app before verifying.');
    const ids = selection ?? cases.map(({ id }) => id);
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !cases.some((scenario) => scenario.id === id))) {
      throw new Problem(400, 'Choose valid verification scenarios.');
    }
    const signature = this.signature;
    const gap = this.gap;
    const pending = cases.filter(({ id }) => ids.includes(id));
    this.current.approval = null;
    for (const scenario of pending) {
      this.running.add(scenario.id);
      delete this.current.results[scenario.id];
    }
    this.save();
    const workers = Math.min(pending.length, Math.max(1, Number(process.env.KANE_WORKERS ?? 2) || 2));
    for (let index = 0; index < workers; index++) {
      this.worker(pending, port, signature, gap).catch(console.error);
    }
    return this.view();
  }

  async worker(pending, port, signature, gap) {
    while (pending.length) {
      const scenario = pending.shift();
      let report;
      try {
        report = await this.execute(scenario, port, signature, gap);
      } catch (error) {
        report = { id: `scenario-${scenario.id}-error`, case: scenario.id, signature, status: 'Error', reason: error.message };
      }
      if (this.signature === signature) this.current.results[scenario.id] = report;
      this.running.delete(scenario.id);
      this.save();
    }
  }

  async execute(scenario, port, signature, gap) {
    const id = `scenario-${scenario.id}-${Date.now()}`;
    const folder = join(this.directory, id);
    mkdirSync(folder, { recursive: true });
    let result;
    let run;
    let analyzer;
    for (let retry = 0; retry < 2; retry++) {
      const created = this.createRun(scenario.id, gap);
      run = created.run;
      const address = `http://127.0.0.1:${port}/scenario?case=${scenario.id}&run=${created.id}`;
      const resultFolder = resolve(folder, `attempt-${retry + 1}`);
      mkdirSync(resultFolder, { recursive: true });
      await withChrome(async (endpoint) => {
        result = await launch('kane-cli', ['run', objective(scenario), '--url', address, '--agent',
          '--name', id, '--cdp-endpoint', endpoint, '--timeout', '260', '--bug-detection', 'stop',
          '--assertion-mode', scenario.visual ? 'visual' : 'dom'], resultFolder, 285_000);
        writeFileSync(join(resultFolder, 'run.ndjson'), result.stdout);
        writeFileSync(join(resultFolder, 'run.stderr'), result.stderr);
        if (result.code !== 0 || result.end?.status !== 'passed') return;
        const checks = invariants(scenario, run.reservations.getState()).flatMap((condition) => ['--condition', condition]);
        analyzer = await launch('kane-cli', ['run', '--analyzer-only', '--agent', '--cdp-endpoint',
          endpoint, '--timeout', '65', ...checks], resultFolder, 80_000);
        writeFileSync(join(resultFolder, 'analyzer.ndjson'), analyzer.stdout);
        writeFileSync(join(resultFolder, 'analyzer.stderr'), analyzer.stderr);
      });
      const warning = result.events.some(({ code }) => code === 'unresolved_variables');
      const blocked = [2, 3].includes(result.code) || result.end?.status === 'broken' || warning;
      if (!blocked && (!analyzer || analyzer.code === 0)) break;
    }
    const warning = result.events.some(({ code }) => code === 'unresolved_variables');
    const end = result.end;
    const conditions = analyzer?.end?.condition_results;
    const state = run.reservations.getState();
    const comparison = compareState(scenario, end?.final_state, state);
    const evidence = copyEvidence(result, folder);
    const passed = result.code === 0 && end?.status === 'passed' && !warning &&
      analyzer?.code === 0 && conditions?.length > 0 && conditions.every(Boolean) && comparison.every(({ match }) => match);
    const setup = [2, 3].includes(result.code) || end?.status === 'broken' || warning || !end || analyzer?.code > 0;
    const status = passed ? 'Passed' : setup ? 'Error' : 'Failed';
    const reason = end?.reason || result.stderr.trim().split('\n').at(-1) || 'Kane did not return a verdict.';
    const report = { id, case: scenario.id, signature, status, reason, summary: end?.summary,
      resultCode: end?.result_code, cliExit: result.code, conditions, comparison, ...evidence };
    writeJson(join(folder, 'report.json'), { ...report, serverTrace: run.events });
    if (status === 'Failed') {
      const source = scenario.id === 11 ? ['public/app.js', 'public/style.css'] : ['public/app.js', 'public/cases.js', 'src/domain.mjs'];
      writeJson(join(folder, 'codex.json'), { scenario: scenario.title, objective: objective(scenario), reason,
        fields: comparison, verdict: end?.verdict, network: evidence.network, source,
        screenshot: evidence.screenshot ? join(folder, 'browser.png') : null,
        failureRecord: evidence.failure ? join(folder, 'failure.yaml') : null });
    }
    return report;
  }
}
