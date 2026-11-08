import express from "express";
import { randomUUID } from "node:crypto";
import { nextBookingId } from "./db.js";
export function createApp(db) {
  const app = express();
  const sessions = new Map();
  app.use(express.json({ limit: "10kb" }));
  app.use((req, res, next) => {
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`
    )
      return res.status(403).json({ error: "허용되지 않은 요청입니다." });
    const token = req.headers.cookie
      ?.split("; ")
      .find((c) => c.startsWith("session="))
      ?.slice(8);
    req.user = sessions.get(token);
    req.token = token;
    next();
  });
  const auth = (req, res, next) =>
    req.user ? next() : res.status(401).json({ error: "로그인이 필요합니다." });
  const admin = (req, res, next) =>
    req.user?.role === "admin"
      ? next()
      : res.status(403).json({ error: "관리자만 가능합니다." });
  const validSlot = (slot) =>
    typeof slot === "string" &&
    /^\d{4}-\d{2}-\d{2}T(09|1[0-7]):00:00\+09:00$/.test(slot) &&
    Number.isFinite(Date.parse(slot)) &&
    new Date(Date.parse(slot) + 9 * 3600000).toISOString().slice(0, 19) ===
      slot.slice(0, 19) &&
    Date.parse(slot) > Date.now() &&
    Date.parse(slot) < Date.now() + 30 * 86400000;
  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body || {};
    if (
      !["alice", "bob", "admin"].includes(username) ||
      password !== "demo1234"
    )
      return res
        .status(401)
        .json({ error: "계정 또는 비밀번호를 확인해 주세요." });
    if (req.token) sessions.delete(req.token);
    const user = {
      name: username,
      role: username === "admin" ? "admin" : "user",
    };
    const token = randomUUID();
    sessions.set(token, user);
    res
      .cookie("session", token, { httpOnly: true, sameSite: "strict" })
      .json(user);
  });
  app.post("/api/logout", (req, res) => {
    sessions.delete(req.token);
    res.clearCookie("session").json({ ok: true });
  });
  app.get("/api/me", auth, (req, res) => res.json(req.user));
  app.get("/api/slots", auth, (req, res) => {
    const date = req.query.date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ error: "날짜 형식이 올바르지 않습니다." });
    const slots = Array.from(
      { length: 9 },
      (_, i) => `${date}T${String(i + 9).padStart(2, "0")}:00:00+09:00`,
    );
    res.json(
      slots.map((slot) => ({
        slot,
        available:
          validSlot(slot) &&
          !db
            .prepare(
              "SELECT 1 FROM bookings WHERE slot=? AND status='confirmed'",
            )
            .get(slot) &&
          !db.prepare("SELECT 1 FROM blocked_slots WHERE slot=?").get(slot),
        blocked: !!db
          .prepare("SELECT 1 FROM blocked_slots WHERE slot=?")
          .get(slot),
      })),
    );
  });
  app.get("/api/bookings", auth, (req, res) =>
    res.json(
      db
        .prepare("SELECT * FROM bookings WHERE user=? ORDER BY slot DESC")
        .all(req.user.name),
    ),
  );
  app.post("/api/bookings", auth, (req, res) => {
    const single = !Object.hasOwn(req.body || {}, "slots");
    const requested = single ? [req.body?.slot] : req.body.slots;
    if (
      !Array.isArray(requested) ||
      requested.length < 1 ||
      requested.length > 9 ||
      !requested.every(validSlot) ||
      new Set(requested).size !== requested.length ||
      new Set(requested.map((slot) => slot.slice(0, 10))).size !== 1
    )
      return res
        .status(400)
        .json({ error: "같은 날짜의 예약 가능한 시간을 선택해 주세요." });
    const created = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      const createdAt = Date.now();
      for (const slot of requested) {
        const booking = {
          id: nextBookingId(db, createdAt),
          user: req.user.name,
          slot,
          status: "confirmed",
        };
        if (
          db
            .prepare("SELECT 1 FROM blocked_slots WHERE slot=?")
            .get(booking.slot)
        ) {
          db.exec("ROLLBACK");
          return res
            .status(409)
            .json({
              error: "선택한 시간 중 잠긴 시간이 있습니다. 다시 선택해 주세요.",
            });
        }
        db.prepare("INSERT INTO bookings VALUES(?,?,?,'confirmed')").run(
          booking.id,
          booking.user,
          booking.slot,
        );
        created.push(booking);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      if (e.message.includes("UNIQUE constraint"))
        return res
          .status(409)
          .json({
            error:
              "선택한 시간 중 이미 예약된 시간이 있습니다. 다시 선택해 주세요.",
          });
      throw e;
    }
    res.status(201).json(single ? created[0] : created);
  });
  app.post("/api/bookings/cancel", auth, (req, res) => {
    const ids = req.body?.ids;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 9 ||
      !ids.every((id) => typeof id === "string") ||
      new Set(ids).size !== ids.length
    )
      return res.status(400).json({ error: "취소할 예약을 확인해 주세요." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = ids.map((id) =>
        db
          .prepare("SELECT * FROM bookings WHERE id=? AND user=?")
          .get(id, req.user.name),
      );
      if (rows.some((row) => !row)) {
        db.exec("ROLLBACK");
        return res.status(404).json({ error: "예약을 찾을 수 없습니다." });
      }
      for (const id of ids)
        db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(id);
      db.exec("COMMIT");
      res.json({ ok: true });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
  app.post("/api/bookings/:id/cancel", auth, (req, res) => {
    const booking = db
      .prepare("SELECT * FROM bookings WHERE id=? AND user=?")
      .get(req.params.id, req.user.name);
    if (!booking)
      return res.status(404).json({ error: "예약을 찾을 수 없습니다." });
    db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(
      booking.id,
    );
    res.json({ ...booking, status: "cancelled" });
  });
  app.put("/api/admin/slots", auth, admin, (req, res) => {
    const { slot, blocked } = req.body || {};
    if (!validSlot(slot) || typeof blocked !== "boolean")
      return res
        .status(400)
        .json({ error: "시간과 잠금 상태를 확인해 주세요." });
    if (
      blocked &&
      db
        .prepare("SELECT 1 FROM bookings WHERE slot=? AND status='confirmed'")
        .get(slot)
    )
      return res.status(409).json({ error: "예약된 시간은 잠글 수 없습니다." });
    if (blocked)
      db.prepare("INSERT OR IGNORE INTO blocked_slots VALUES(?)").run(slot);
    else db.prepare("DELETE FROM blocked_slots WHERE slot=?").run(slot);
    res.json({ slot, blocked });
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "없는 API입니다." }),
  );
  app.use((err, req, res, next) => {
    console.error(err.message);
    res.status(err.status || 500).json({
      error:
        err.status === 400
          ? "잘못된 JSON 요청입니다."
          : "요청을 처리하지 못했습니다.",
    });
  });
  return app;
}
