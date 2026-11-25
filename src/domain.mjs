import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export const actors = ['Minji', 'Junho', 'Sora', 'Yuna', 'Jimin'];
export const equipment = ['Camera', 'Lens'];
export const selections = { Camera: ['Camera'], Lens: ['Lens'], Kit: equipment };

export class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateSlot({ kind, start, end }) {
  if (!Object.hasOwn(selections, kind) || !Number.isInteger(start) || !Number.isInteger(end) ||
      start < 540 || end > 1080 || end <= start || start % 15 || end % 15) {
    throw new Problem(400, 'Choose equipment and a valid 15-minute interval between 09:00 and 18:00.');
  }
}

export class Reservations {
  constructor(path, fixture = [], gap = 0) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        gap INTEGER NOT NULL CHECK (gap IN (0, 30)),
        revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS booking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('Camera', 'Lens', 'Kit')),
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('Confirmed', 'Waiting', 'Cancelled')),
        cancelled_from TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_booking
        ON booking(actor, kind, start, end) WHERE status != 'Cancelled';
      CREATE TABLE IF NOT EXISTS receipt (
        actor TEXT NOT NULL,
        key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status INTEGER NOT NULL,
        response TEXT NOT NULL,
        PRIMARY KEY (actor, key)
      );
    `);
    this.transaction(() => {
      if (!this.db.prepare('INSERT OR IGNORE INTO state VALUES (1, ?, 0)').run(gap).changes) return;
      const insert = this.db.prepare('INSERT INTO booking (actor, kind, start, end, status, cancelled_from) VALUES (?, ?, ?, ?, ?, ?)');
      for (const row of fixture) insert.run(row.actor, row.kind, row.start, row.end, row.status, row.cancelledFrom ?? null);
    });
  }

  close() {
    this.db.close();
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getState() {
    const { gap, revision } = this.db.prepare('SELECT gap, revision FROM state').get();
    const bookings = this.db.prepare('SELECT id, actor, kind, start, end, status FROM booking ORDER BY id').all();
    const allocations = bookings.filter(({ status }) => status === 'Confirmed').flatMap((row) =>
      selections[row.kind].map((item) => ({ item, bookingId: row.id, actor: row.actor, start: row.start, end: row.end })));
    return { gap, revision, bookings, allocations };
  }

  setGap(gap) {
    if (![0, 30].includes(gap)) throw new Problem(400, 'Choose a 0 or 30 minute inspection gap.');
    return this.transaction(() => {
      this.db.prepare('UPDATE state SET gap = ?, revision = revision + 1 WHERE gap != ?').run(gap, gap);
      return this.getState();
    });
  }

  getBooking(id) {
    return this.db.prepare('SELECT * FROM booking WHERE id = ?').get(id);
  }

  requireOwner(actor, id) {
    const item = this.getBooking(id);
    if (!item) throw new Problem(404, 'Reservation was not found.');
    if (item.actor !== actor) throw new Problem(403, 'Only the reservation owner can make this change.');
    return item;
  }

  availability(slot, excludeId = 0) {
    const { gap } = this.db.prepare('SELECT gap FROM state').get();
    const confirmed = this.db.prepare("SELECT * FROM booking WHERE status = 'Confirmed' AND id != ?").all(excludeId);
    return !confirmed.some((row) => selections[slot.kind].some((item) => {
      if (!selections[row.kind].includes(item)) return false;
      const padding = item === 'Camera' ? gap : 0;
      return slot.start < row.end + padding && row.start < slot.end + padding;
    }));
  }

  duplicate(actor, slot, excludeId = 0) {
    return this.db.prepare("SELECT * FROM booking WHERE actor = ? AND kind = ? AND start = ? AND end = ? AND status != 'Cancelled' AND id != ?")
      .get(actor, slot.kind, slot.start, slot.end, excludeId);
  }

  promote() {
    const waiting = this.db.prepare("SELECT * FROM booking WHERE status = 'Waiting' ORDER BY id").all();
    for (const row of waiting) {
      if (this.availability(row)) this.db.prepare("UPDATE booking SET status = 'Confirmed' WHERE id = ?").run(row.id);
    }
  }

  mutate(actor, action, input, key) {
    if (!actors.includes(actor)) throw new Problem(400, 'Choose a demo user.');
    if (!['create', 'cancel', 'edit', 'restore'].includes(action)) throw new Problem(400, 'Unknown reservation action.');
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 128)) {
      throw new Problem(400, 'Invalid request key.');
    }
    const normalized = action === 'create'
      ? { kind: input.kind, start: input.start, end: input.end, wait: input.wait === true }
      : action === 'edit' ? { id: input.id, start: input.start, end: input.end } : { id: input.id };
    const fingerprint = createHash('sha256').update(JSON.stringify([action, normalized])).digest('hex');

    return this.transaction(() => {
      if (key) {
        const receipt = this.db.prepare('SELECT * FROM receipt WHERE actor = ? AND key = ?').get(actor, key);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) throw new Problem(409, 'This request key was already used with different input.');
          return { code: receipt.status, item: JSON.parse(receipt.response), replayed: true };
        }
      }

      let item;
      let code = 200;
      if (action === 'create') {
        validateSlot(normalized);
        item = this.duplicate(actor, normalized);
        if (!item) {
          const available = this.availability(normalized);
          if (!available && !normalized.wait) throw new Problem(409, 'That time is unavailable.');
          const { kind, start, end } = normalized;
          const id = this.db.prepare('INSERT INTO booking (actor, kind, start, end, status) VALUES (?, ?, ?, ?, ?)')
            .run(actor, kind, start, end, available ? 'Confirmed' : 'Waiting').lastInsertRowid;
          item = this.getBooking(id);
          code = 201;
          this.touch();
        }
      } else {
        const current = this.requireOwner(actor, normalized.id);
        if (action === 'cancel') {
          if (current.status !== 'Cancelled') {
            this.db.prepare("UPDATE booking SET status = 'Cancelled', cancelled_from = ? WHERE id = ?")
              .run(current.status, current.id);
            this.promote();
            this.touch();
          }
        } else if (action === 'restore') {
          if (current.status !== 'Cancelled' || current.cancelled_from !== 'Confirmed') {
            throw new Problem(409, 'Only a previously confirmed reservation can be restored.');
          }
          if (this.duplicate(actor, current, current.id) || !this.availability(current, current.id)) {
            throw new Problem(409, 'Restore blocked because the original slot is unavailable.');
          }
          this.db.prepare("UPDATE booking SET status = 'Confirmed', cancelled_from = NULL WHERE id = ?").run(current.id);
          this.touch();
        } else {
          const next = { ...current, start: normalized.start, end: normalized.end };
          validateSlot(next);
          if (current.status !== 'Confirmed' || this.duplicate(actor, next, current.id) || !this.availability(next, current.id)) {
            throw new Problem(409, 'Time change blocked. The original reservation was kept.');
          }
          this.db.prepare('UPDATE booking SET start = ?, end = ? WHERE id = ?').run(next.start, next.end, current.id);
          this.promote();
          this.touch();
        }
        item = this.getBooking(current.id);
      }

      if (key) {
        this.db.prepare('INSERT INTO receipt VALUES (?, ?, ?, ?, ?)').run(actor, key, fingerprint, code, JSON.stringify(item));
      }
      return { code, item, replayed: false };
    });
  }

  touch() {
    this.db.exec('UPDATE state SET revision = revision + 1');
  }
}
