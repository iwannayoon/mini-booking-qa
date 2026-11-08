import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS bookings(id TEXT PRIMARY KEY, user TEXT NOT NULL, slot TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('confirmed','cancelled')));
    CREATE UNIQUE INDEX IF NOT EXISTS active_slot ON bookings(slot) WHERE status='confirmed';
    CREATE TABLE IF NOT EXISTS blocked_slots(slot TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS booking_sequences(date TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
  return db;
}

// Call inside the booking transaction so allocation and insertion commit together.
export function nextBookingId(db, now = Date.now()) {
  const date = new Date(now + 9 * 3600000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
  const { value } = db.prepare(`
    INSERT INTO booking_sequences(date, value) VALUES(?, 1)
    ON CONFLICT(date) DO UPDATE SET value = value + 1
    RETURNING value
  `).get(date);
  return `${date}-${String(value).padStart(4, "0")}`;
}
