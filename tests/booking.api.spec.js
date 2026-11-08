import { test, expect } from "@playwright/test";
import { openDb, nextBookingId } from "../server/db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const slot = (day, hour = 9) =>
  new Date(Date.now() + day * 86400000 + 9 * 3600000)
    .toISOString()
    .slice(0, 10) + `T${String(hour).padStart(2, "0")}:00:00+09:00`;
async function login(playwright, name = "alice") {
  const client = await playwright.request.newContext({
    baseURL: "http://127.0.0.1:3100",
  });
  expect(
    (
      await client.post("/api/login", {
        data: { username: name, password: "demo1234" },
      })
    ).status(),
  ).toBe(200);
  return client;
}
// N-01·N-04는 저장 계층을 직접 열어 검증합니다. 각 테스트는 메모리 또는 전용 임시 DB를 사용합니다.
test("[TC-B-24] A 부분 고유 인덱스와 취소 이력 보존", () => {
  const db = openDb(":memory:");
  try {
    db.prepare(
      "INSERT INTO bookings VALUES('a','alice','slot','confirmed')",
    ).run();
    expect(() =>
      db
        .prepare("INSERT INTO bookings VALUES('b','bob','slot','confirmed')")
        .run(),
    ).toThrow();
    db.prepare("UPDATE bookings SET status='cancelled' WHERE id='a'").run();
    db.prepare(
      "INSERT INTO bookings VALUES('b','bob','slot','confirmed')",
    ).run();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM bookings").get().count,
    ).toBe(2);
  } finally {
    db.close();
  }
});

// 서버 재시작과 같은 조건이 되도록 같은 DB 파일을 닫았다가 다시 엽니다.
test("[TC-B-24] B DB 재연결 후 예약·잠금 유지", () => {
  const dir = mkdtempSync(join(tmpdir(), "booking-persist-"));
  const path = join(dir, "test.sqlite");
  let db = openDb(path);
  try {
    db.prepare("INSERT INTO bookings VALUES('p1', 'alice', '2030-01-11T09:00:00+09:00', 'confirmed')").run();
    db.prepare("INSERT INTO bookings VALUES('p2', 'alice', '2030-01-11T10:00:00+09:00', 'cancelled')").run();
    db.prepare("INSERT INTO blocked_slots VALUES('2030-01-11T11:00:00+09:00')").run();
    db.close();
    db = openDb(path);
    expect(db.prepare("SELECT id, status FROM bookings ORDER BY id").all().map(r => ({ ...r })))
      .toEqual([{ id: "p1", status: "confirmed" }, { id: "p2", status: "cancelled" }]);
    expect(db.prepare("SELECT slot FROM blocked_slots").all().map(r => r.slot))
      .toEqual(["2030-01-11T11:00:00+09:00"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[TC-B-25] A 날짜별 순번·자정 초기화·재연결 유지·롤백 복원", () => {
  const dir = mkdtempSync(join(tmpdir(), "booking-id-"));
  const path = join(dir, "test.sqlite");
  let db = openDb(path);
  const beforeMidnight = Date.parse("2026-09-28T23:59:59+09:00");
  const afterMidnight = Date.parse("2026-09-29T00:00:00+09:00");
  try {
    db.exec("BEGIN IMMEDIATE");
    const id = nextBookingId(db, beforeMidnight);
    expect(id).toBe("20260928-0001");
    db.prepare("INSERT INTO bookings VALUES(?, 'alice', 'slot', 'confirmed')").run(id);
    db.exec("COMMIT");
    db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(id);
    db.close();
    db = openDb(path);
    db.exec("BEGIN IMMEDIATE");
    expect(nextBookingId(db, beforeMidnight)).toBe("20260928-0002");
    db.exec("ROLLBACK");
    db.exec("BEGIN IMMEDIATE");
    expect(nextBookingId(db, beforeMidnight)).toBe("20260928-0002");
    expect(nextBookingId(db, beforeMidnight)).toBe("20260928-0003");
    expect(nextBookingId(db, afterMidnight)).toBe("20260929-0001");
    db.exec("COMMIT");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// TC-B API 케이스. 각 테스트는 자신이 쓰는 슬롯을 소유하고 finally에서 취소·잠금 해제합니다.
import { startClockServer, client, create, rows, slotState, cancelSlots } from "./helpers/booking.js";

// 서버 시간 기준 케이스는 KST 2030-01-10 10:00으로 고정한 전용 서버에서 실행합니다.
test.describe("서버 시계 고정 2030-01-10 10:00 KST", () => {
  let server;
  test.beforeAll(async () => { server = await startClockServer("2030-01-10T10:00:00+09:00"); });
  test.afterAll(async () => { await server?.stop(); });

  for (const [label, cases] of [
    ["A 현재 시각 경계", [["2030-01-10T09:00:00+09:00", 400], ["2030-01-10T10:00:00+09:00", 400], ["2030-01-10T11:00:00+09:00", 201]]],
    ["B 30일 경계", [["2030-02-09T09:00:00+09:00", 201], ["2030-02-09T10:00:00+09:00", 400], ["2030-02-09T11:00:00+09:00", 400]]],
    ["C 영업시간 경계", [["2030-01-11T08:00:00+09:00", 400], ["2030-01-11T09:00:00+09:00", 201], ["2030-01-11T17:00:00+09:00", 201], ["2030-01-11T18:00:00+09:00", 400]]],
    ["D 정각 아님", [["2030-01-11T09:30:00+09:00", 400]]],
  ]) {
    test(`[TC-B-01] ${label}`, async ({ playwright }) => {
      const a = await client(playwright, server.baseURL);
      const values = cases.map(([value]) => value);
      try {
        for (const [value, status] of cases) {
          const response = await a.post("/api/bookings", { data: { slot: value } });
          expect(response.status(), value).toBe(status);
          // 거부된 요청은 예약을 남기지 않아야 합니다.
          const stored = (await rows(a)).filter(r => r.slot === value && r.status === "confirmed");
          expect(stored, value).toHaveLength(status === 201 ? 1 : 0);
        }
      } finally { await cancelSlots(a, values); await a.dispose(); }
    });
  }

  // 미래 슬롯을 예약한 뒤 서버 시계만 슬롯 종료 이후로 전진시킵니다.
  test("[TC-B-19] A 과거 예약 단일 취소", async ({ playwright }) => {
    const a = await client(playwright, server.baseURL);
    const value = "2030-01-12T09:00:00+09:00";
    try {
      const row = await create(a, { slot: value });
      await server.setNow("2030-01-12T12:00:00+09:00");
      expect((await slotState(a, value)).available).toBe(false);
      const response = await a.post(`/api/bookings/${row.id}/cancel`);
      expect(response.status()).toBe(200);
      expect((await rows(a)).find(r => r.id === row.id).status).toBe("cancelled");
    } finally {
      await server.setNow("2030-01-10T10:00:00+09:00");
      await cancelSlots(a, [value]); await a.dispose();
    }
  });
  test("[TC-B-19] B 과거 예약 묶음 취소", async ({ playwright }) => {
    const a = await client(playwright, server.baseURL);
    const values = ["2030-01-13T09:00:00+09:00", "2030-01-13T10:00:00+09:00"];
    try {
      const ids = (await create(a, { slots: values })).map(r => r.id);
      await server.setNow("2030-01-13T12:00:00+09:00");
      for (const value of values) expect((await slotState(a, value)).available).toBe(false);
      expect((await a.post("/api/bookings/cancel", { data: { ids } })).status()).toBe(200);
      const stored = await rows(a);
      for (const id of ids) expect(stored.find(r => r.id === id).status).toBe("cancelled");
    } finally {
      await server.setNow("2030-01-10T10:00:00+09:00");
      await cancelSlots(a, values); await a.dispose();
    }
  });

  // slot 오류 조합은 blocked=true, blocked 오류 조합은 유효한 빈 슬롯으로 고정합니다.
  const free = "2030-01-11T12:00:00+09:00";
  for (const [label, data] of [
    ["A slot null", { slot: null, blocked: true }],
    ["A slot 형식 오류", { slot: "2030-01-11 12:00", blocked: true }],
    ["B 과거 슬롯", { slot: "2030-01-10T09:00:00+09:00", blocked: true }],
    ["B 정확히 현재", { slot: "2030-01-10T10:00:00+09:00", blocked: true }],
    ["B 정확히 30일 후", { slot: "2030-02-09T10:00:00+09:00", blocked: true }],
    ["C 08시", { slot: "2030-01-11T08:00:00+09:00", blocked: true }],
    ["C 18시", { slot: "2030-01-11T18:00:00+09:00", blocked: true }],
    ["C 09:30", { slot: "2030-01-11T09:30:00+09:00", blocked: true }],
    ['D blocked="true"', { slot: free, blocked: "true" }],
    ["E blocked=1", { slot: free, blocked: 1 }],
    ["F blocked=null", { slot: free, blocked: null }],
    ["F blocked 누락", { slot: free }],
  ]) {
    test(`[TC-B-23] ${label} 관리자 입력 거부`, async ({ playwright }) => {
      const admin = await client(playwright, server.baseURL, "admin");
      // 08·18·09:30은 슬롯 목록에 없으므로 인접한 유효 슬롯의 잠금 상태로 확인합니다.
      const watched = ["2030-01-10T10:00:00+09:00", "2030-01-11T09:00:00+09:00", "2030-01-11T17:00:00+09:00", free, "2030-02-09T09:00:00+09:00"];
      try {
        const response = await admin.put("/api/admin/slots", { data });
        expect(response.status()).toBe(400);
        for (const value of watched) expect((await slotState(admin, value)).blocked, value).toBe(false);
      } finally {
        await admin.put("/api/admin/slots", { data: { slot: free, blocked: false } });
        await admin.dispose();
      }
    });
  }
});

// 존재하지 않는 날짜 검증이 30일 범위 조건에 가려지지 않도록 2030-02-01로 고정합니다.
test.describe("서버 시계 고정 2030-02-01 KST", () => {
  let server;
  test.beforeAll(async () => { server = await startClockServer("2030-02-01T00:00:00+09:00"); });
  test.afterAll(async () => { await server?.stop(); });

  test("[TC-B-03] A 날짜 형식 오류 조회 거부", async ({ playwright }) => {
    const a = await client(playwright, server.baseURL);
    try {
      expect((await a.get("/api/slots?date=2030/02/10")).status()).toBe(400);
    } finally { await a.dispose(); }
  });
  test("[TC-B-03] B 존재하지 않는 날짜 조회는 모두 예약 불가", async ({ playwright }) => {
    const a = await client(playwright, server.baseURL);
    try {
      const response = await a.get("/api/slots?date=2030-02-30");
      expect(response.status()).toBe(200);
      const slots = await response.json();
      expect(slots).toHaveLength(9);
      expect(slots.every(s => s.available === false)).toBe(true);
    } finally { await a.dispose(); }
  });
  test("[TC-B-03] C 존재하지 않는 날짜 예약 거부", async ({ playwright }) => {
    const a = await client(playwright, server.baseURL);
    try {
      const before = await rows(a);
      const response = await a.post("/api/bookings", { data: { slot: "2030-02-30T09:00:00+09:00" } });
      expect(response.status()).toBe(400);
      expect(await rows(a)).toEqual(before);
    } finally { await a.dispose(); }
  });
});

// 아래 케이스는 공용 테스트 서버를 사용하며, 케이스마다 겹치지 않는 날짜(오늘+8~18일)를 씁니다.
for (const [label, day, data, count] of [
  ["A 단일 slot", 8, { slot: slot(8, 9) }, 0],
  ["B slots 1개", 9, { slots: [slot(9, 9)] }, 1],
  ["C slots 9개", 10, { slots: Array.from({ length: 9 }, (_, i) => slot(10, 9 + i)) }, 9],
]) {
  test(`[TC-B-07] ${label} 예약 생성`, async ({ playwright }) => {
    const a = await login(playwright);
    const values = data.slots ?? [data.slot];
    try {
      const response = await a.post("/api/bookings", { data });
      expect(response.status()).toBe(201);
      // 단일 slot은 객체, slots는 요청 수만큼의 배열을 반환합니다.
      const body = await response.json();
      if (count) { expect(Array.isArray(body)).toBe(true); expect(body).toHaveLength(count); }
      else expect(Array.isArray(body)).toBe(false);
      const created = count ? body : [body];
      expect(created.map(r => r.slot)).toEqual(values);
      expect(new Set(created.map(r => r.id)).size).toBe(values.length);
      const stored = await rows(a);
      for (const row of created)
        expect(stored.find(r => r.id === row.id)).toEqual({ id: row.id, user: "alice", slot: row.slot, status: "confirmed" });
    } finally { await cancelSlots(a, values); await a.dispose(); }
  });
}

for (const [label, data] of [
  ["A slot null", { slot: null }],
  ["A slot 잘못된 문자열", { slot: "tomorrow 9am" }],
  ["B slots 빈 배열", { slots: [] }],
  ["C slots 중복", { slots: [slot(11, 9), slot(11, 9)] }],
  ["D slots 다른 날짜", { slots: [slot(11, 9), slot(12, 9)] }],
  ["E slots 문자열", { slots: slot(11, 9) }],
  ["F slots 10개", { slots: [...Array.from({ length: 9 }, (_, i) => slot(11, 9 + i)), slot(12, 9)] }],
  ["G slots [null]", { slots: [null] }],
]) {
  test(`[TC-B-08] ${label} 예약 입력 거부`, async ({ playwright }) => {
    const a = await login(playwright);
    try {
      // 요청 전후 본인 예약 목록이 같아야 일부 생성도 없었음을 보장합니다.
      const before = await rows(a);
      expect((await a.post("/api/bookings", { data })).status()).toBe(400);
      expect(await rows(a)).toEqual(before);
    } finally {
      await cancelSlots(a, [...Array.from({ length: 9 }, (_, i) => slot(11, 9 + i)), slot(12, 9)]);
      await a.dispose();
    }
  });
}

for (const [label, occupy, data] of [
  ["A 예약된 10시 단일", "booked", (s) => ({ slot: s[1] })],
  ["B 잠긴 10시 단일", "blocked", (s) => ({ slot: s[1] })],
  ["C 09·10시 중 10시 예약됨", "booked", (s) => ({ slots: s })],
  ["D 09·10시 중 10시 잠김", "blocked", (s) => ({ slots: s })],
]) {
  test(`[TC-B-09] ${label} 충돌과 전체 롤백`, async ({ playwright }) => {
    const a = await login(playwright), b = await login(playwright, "bob"), admin = await login(playwright, "admin");
    const s = [slot(12, 9), slot(12, 10)];
    let occupied;
    try {
      if (occupy === "booked") occupied = await create(b, { slot: s[1] });
      else expect((await admin.put("/api/admin/slots", { data: { slot: s[1], blocked: true } })).status()).toBe(200);
      expect((await a.post("/api/bookings", { data: data(s) })).status()).toBe(409);
      expect((await rows(a)).filter(r => s.includes(r.slot) && r.status === "confirmed")).toHaveLength(0);
      // 복수 요청에 포함된 빈 09시도 롤백되어 여전히 예약 가능해야 합니다.
      expect(await slotState(a, s[0])).toMatchObject({ available: true, blocked: false });
      // 기존 bob 예약·관리자 잠금은 유지됩니다.
      if (occupied) expect((await rows(b)).find(r => r.id === occupied.id).status).toBe("confirmed");
      else expect((await slotState(a, s[1])).blocked).toBe(true);
    } finally {
      await admin.put("/api/admin/slots", { data: { slot: s[1], blocked: false } });
      await cancelSlots(a, s); await cancelSlots(b, s);
      for (const c of [a, b, admin]) await c.dispose();
    }
  });
}

// 승자를 고정하지 않고 응답 상태 조합과 최종 확정 건수만 판정합니다.
test("[TC-B-10] 동일 슬롯 경쟁 요청은 하나만 확정", async ({ playwright }) => {
  const a = await login(playwright), b = await login(playwright, "bob");
  const value = slot(13, 9);
  try {
    const replies = await Promise.all([a, b].map(c => c.post("/api/bookings", { data: { slot: value } })));
    expect(replies.map(r => r.status()).sort()).toEqual([201, 409]);
    const confirmed = [...await rows(a), ...await rows(b)].filter(r => r.slot === value && r.status === "confirmed");
    expect(confirmed).toHaveLength(1);
  } finally {
    await cancelSlots(a, [value]); await cancelSlots(b, [value]);
    await a.dispose(); await b.dispose();
  }
});

for (const [label, day, size, cancel] of [
  ["A 단일 취소", 14, 1, (c, ids) => c.post(`/api/bookings/${ids[0]}/cancel`)],
  ["B ids 1개", 15, 1, (c, ids) => c.post("/api/bookings/cancel", { data: { ids } })],
  ["C ids 9개", 16, 9, (c, ids) => c.post("/api/bookings/cancel", { data: { ids } })],
]) {
  test(`[TC-B-17] ${label} 및 반복 취소`, async ({ playwright }) => {
    const a = await login(playwright);
    const values = Array.from({ length: size }, (_, i) => slot(day, 9 + i));
    try {
      const ids = (await create(a, { slots: values })).map(r => r.id);
      // 같은 요청을 두 번 보내도 200이며, 행은 삭제되지 않고 cancelled로 남습니다.
      for (const attempt of ["첫 취소", "재취소"]) {
        expect((await cancel(a, ids)).status(), attempt).toBe(200);
        const stored = await rows(a);
        for (const id of ids) expect(stored.find(r => r.id === id)?.status, attempt).toBe("cancelled");
      }
    } finally { await cancelSlots(a, values); await a.dispose(); }
  });
}

// 형식 오류 조합에도 유효한 alice ID를 넣어 부분 취소가 없는지 함께 확인합니다.
for (const [label, status, ids] of [
  ["A ids 빈 배열", 400, () => []],
  ["B ids 문자열", 400, (a) => a],
  ["C 중복 ID", 400, (a) => [a, a]],
  ["D 문자열 아닌 ID 포함", 400, (a) => [a, 123]],
  ["E 서로 다른 ID 10개", 400, (a) => [a, ...Array.from({ length: 9 }, (_, i) => `missing-${i}`)]],
  ["F alice ID + bob ID", 404, (a, b) => [a, b]],
  ["G alice ID + 없는 ID", 404, (a) => [a, "missing-booking-id"]],
]) {
  test(`[TC-B-18] ${label} 취소 거부와 원자성`, async ({ playwright }) => {
    const a = await login(playwright), b = await login(playwright, "bob");
    const values = [slot(17, 9), slot(17, 10)];
    try {
      const mine = await create(a, { slot: values[0] });
      const theirs = await create(b, { slot: values[1] });
      const response = await a.post("/api/bookings/cancel", { data: { ids: ids(mine.id, theirs.id) } });
      expect(response.status()).toBe(status);
      expect((await rows(a)).find(r => r.id === mine.id).status).toBe("confirmed");
      expect((await rows(b)).find(r => r.id === theirs.id).status).toBe("confirmed");
    } finally {
      await cancelSlots(a, values); await cancelSlots(b, values);
      await a.dispose(); await b.dispose();
    }
  });
}

test("[TC-B-22] 이미 예약된 슬롯 잠금 거부", async ({ playwright }) => {
  const a = await login(playwright), admin = await login(playwright, "admin");
  const value = slot(18, 9);
  try {
    const row = await create(a, { slot: value });
    expect((await admin.put("/api/admin/slots", { data: { slot: value, blocked: true } })).status()).toBe(409);
    // 기존 예약은 유지되고 새 잠금은 생기지 않아야 합니다.
    expect((await rows(a)).find(r => r.id === row.id).status).toBe("confirmed");
    expect((await slotState(admin, value)).blocked).toBe(false);
  } finally {
    await admin.put("/api/admin/slots", { data: { slot: value, blocked: false } });
    await cancelSlots(a, [value]);
    await a.dispose(); await admin.dispose();
  }
});

// 예약 ID는 실제 생성 시각(KST) 기준이므로 오늘 날짜 접두어와 순번 증가만 판정합니다.
test("[TC-B-25] B 복수 예약 슬롯별 연속 발급과 실패 시 순번 롤백", async ({ playwright }) => {
  const a = await login(playwright), b = await login(playwright, "bob");
  const values = [slot(19, 9), slot(19, 10), slot(19, 11)];
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replaceAll("-", "");
  const seq = (id) => Number(id.split("-")[1]);
  try {
    const ids = (await create(a, { slots: values.slice(0, 2) })).map(r => r.id);
    for (const id of ids) expect(id).toMatch(new RegExp(`^${today}-\\d{4,}$`));
    expect(seq(ids[1])).toBe(seq(ids[0]) + 1);
    // 11시를 먼저 발급한 뒤 09시 충돌로 실패하므로, 롤백되면 다음 예약이 순번을 이어받습니다.
    expect((await b.post("/api/bookings", { data: { slots: [values[2], values[0]] } })).status()).toBe(409);
    const next = await create(b, { slot: values[2] });
    expect(seq(next.id)).toBe(seq(ids[1]) + 1);
  } finally {
    await cancelSlots(a, values); await cancelSlots(b, values);
    await a.dispose(); await b.dispose();
  }
});
