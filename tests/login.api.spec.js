// @ts-check
import { test, expect } from "@playwright/test";

// request fixture는 테스트마다 독립된 API 컨텍스트와 쿠키 저장소를 제공합니다.
for (const scenario of [
  { name: "A: 계정·비밀번호 모두 null", password: null },
  { name: "B: 계정만 null", password: "demo1234" },
]) {
  test(`[TC-L-03] ${scenario.name} 요청 거부`, async ({ request }) => {
    const response = await request.post("/api/login", {
      data: {
        username: null,
        password: scenario.password,
      },
    });

    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "계정 또는 비밀번호를 확인해 주세요.",
    });

    // 같은 컨텍스트에서 인증 실패 후에도 비로그인 상태인지 확인합니다.
    const meResponse = await request.get("/api/me");
    expect(meResponse.status()).toBe(401);
  });
}

test("[TC-L-05] 비밀번호가 null인 로그인 요청 거부", async ({ request }) => {
  const response = await request.post("/api/login", {
    data: { username: "alice", password: null },
  });
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({
    error: "계정 또는 비밀번호를 확인해 주세요.",
  });
  const meResponse = await request.get("/api/me");
  expect(meResponse.status()).toBe(401);
});

for (const scenario of [
  { name: "A: 빈 계정", data: { username: "", password: "demo1234" } },
  { name: "B: 빈 비밀번호", data: { username: "alice", password: "" } },
  { name: "C: 계정 필드 생략", data: { password: "demo1234" } },
  { name: "D: 비밀번호 필드 생략", data: { username: "alice" } },
  { name: "E: 두 필드 생략", data: {} },
  { name: "F: 공백 계정", data: { username: "   ", password: "demo1234" } },
  { name: "G: 공백 비밀번호", data: { username: "alice", password: "   " } },
]) {
  test(`[TC-L-07] ${scenario.name} 요청 거부`, async ({ request }) => {
    const response = await request.post("/api/login", { data: scenario.data });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "계정 또는 비밀번호를 확인해 주세요.",
    });
    const meResponse = await request.get("/api/me");
    expect(meResponse.status()).toBe(401);
  });
}

// Authentication and authorization tests use a new request fixture per test.
import { apiLogin, invalidCredentials, date, slot } from "./helpers/login.js";

for (const name of ["alice", "bob", "admin"]) {
  test(`[TC-L-09] ${name} 로그인 응답 이름·역할`, async ({ request }) => {
    try {
      const response = await apiLogin(request, name);
      expect(await response.json()).toEqual({ name, role: name === "admin" ? "admin" : "user" });
    } finally { await request.post("/api/logout"); }
  });
}
for (const [label, username, password] of invalidCredentials) {
  test(`[TC-L-11] ${label} 인증 거부`, async ({ request }) => {
    const response = await request.post("/api/login", { data: { username, password } });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: "계정 또는 비밀번호를 확인해 주세요." });
    expect((await request.get("/api/me")).status()).toBe(401);
  });
}

test("[TC-L-28] 세션·쿠키 제거, 이전 토큰 거부, 반복 호출 및 Origin", async ({ request, playwright, baseURL }) => {
  const login = await apiLogin(request);
  const state = await request.storageState();
  const old = await playwright.request.newContext({ baseURL, storageState: state });
  const fresh = await playwright.request.newContext({ baseURL });
  try {
    // C: 처음부터 쿠키가 없는 컨텍스트의 로그아웃도 200과 {"ok":true}입니다.
    const anonymous = await fresh.post("/api/logout");
    expect(anonymous.status()).toBe(200);
    expect(await anonymous.json()).toEqual({ ok: true });
    const rejected = await request.post("/api/logout", { headers: { Origin: "http://other.example" } });
    expect(rejected.status()).toBe(403);
    expect((await request.get("/api/me")).status()).toBe(200);
    const response = await request.post("/api/logout");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await request.storageState()).cookies.some(c => c.name === "session")).toBe(false);
    for (const client of [request, old]) {
      expect((await client.get("/api/me")).status()).toBe(401);
      expect((await client.get("/api/bookings")).status()).toBe(401);
      const repeated = await client.post("/api/logout");
      expect(repeated.status()).toBe(200);
      expect(await repeated.json()).toEqual({ ok: true });
    }
  } finally { await old.dispose(); await fresh.dispose(); await request.post("/api/logout"); }
});

// Authorization tests prepare real records and verify rejected calls do not mutate them.
async function clients(playwright, baseURL) {
  const result = {};
  for (const name of ["alice", "bob", "admin"]) {
    result[name] = await playwright.request.newContext({ baseURL });
    await apiLogin(result[name], name);
  }
  return result;
}
async function create(client, value) {
  const res = await client.post("/api/bookings", { data: { slot: value } });
  expect(res.status()).toBe(201);
  return res.json();
}
async function clean(c, records = []) {
  for (const [name, row] of records) await c[name].post(`/api/bookings/${row.id}/cancel`);
  for (const client of Object.values(c)) { await client.post("/api/logout"); await client.dispose(); }
}
for (const mode of ["쿠키 없음", "로그아웃된 토큰"]) {
  test(`[TC-L-31] ${mode} 모든 보호 API 거부`, async ({ playwright, baseURL }) => {
    const c = await clients(playwright, baseURL);
    let denied; const records = [];
    try {
      const row = await create(c.alice, slot(20)); records.push(["alice", row]);
      let storageState;
      if (mode === "로그아웃된 토큰") {
        storageState = await c.bob.storageState(); await c.bob.post("/api/logout");
      }
      denied = await playwright.request.newContext({ baseURL, storageState });
      const calls = [
        () => denied.get(`/api/slots?date=${date(20)}`), () => denied.get("/api/bookings"),
        () => denied.post("/api/bookings", { data: { slot: slot(20, 10) } }),
        () => denied.post("/api/bookings", { data: { slots: [slot(20, 11)] } }),
        () => denied.post(`/api/bookings/${row.id}/cancel`),
        () => denied.post("/api/bookings/cancel", { data: { ids: [row.id] } }),
        () => denied.put("/api/admin/slots", { data: { slot: slot(20, 12), blocked: true } }),
      ];
      for (const call of calls) expect((await call()).status()).toBe(401);
      const rows = await (await c.alice.get("/api/bookings")).json();
      expect(rows.find(r => r.id === row.id).status).toBe("confirmed");
      const slots = await (await c.admin.get(`/api/slots?date=${date(20)}`)).json();
      for (const hour of [10, 11, 12]) expect(slots.find(s => s.slot === slot(20, hour))).toMatchObject({ available: true, blocked: false });
    } finally { await denied?.dispose(); await clean(c, records); }
  });
}
for (const name of ["alice", "bob"]) {
  test(`[TC-L-32] ${name} 잠금·해제 권한 거부`, async ({ playwright, baseURL }) => {
    const c = await clients(playwright, baseURL);
    try {
      for (const blocked of [true, false]) {
        await c.admin.put("/api/admin/slots", { data: { slot: slot(21), blocked: !blocked } });
        expect((await c[name].put("/api/admin/slots", { data: { slot: slot(21), blocked } })).status()).toBe(403);
        const rows = await (await c.admin.get(`/api/slots?date=${date(21)}`)).json();
        expect(rows.find(r => r.slot === slot(21)).blocked).toBe(!blocked);
      }
    } finally {
      await c.admin.put("/api/admin/slots", { data: { slot: slot(21), blocked: false } });
      await clean(c);
    }
  });
}
test("[TC-L-33] 각 사용자의 확정·취소 이력만 조회", async ({ playwright, baseURL }) => {
  const c = await clients(playwright, baseURL); const records = [];
  try {
    for (const [i, name] of ["alice", "bob"].entries()) {
      records.push([name, await create(c[name], slot(22, 9 + i * 2))]);
      const cancelled = await create(c[name], slot(22, 10 + i * 2)); records.push([name, cancelled]);
      await c[name].post(`/api/bookings/${cancelled.id}/cancel`);
    }
    for (const name of ["alice", "bob"]) {
      const response = await c[name].get("/api/bookings"); expect(response.status()).toBe(200);
      const rows = await response.json(); expect(rows.every(r => r.user === name)).toBe(true);
      const own = records.filter(([owner]) => owner === name);
      expect(rows.find(r => r.id === own[0][1].id).status).toBe("confirmed");
      expect(rows.find(r => r.id === own[1][1].id).status).toBe("cancelled");
      for (const [owner, row] of records) if (owner !== name) expect(rows.some(r => r.id === row.id)).toBe(false);
    }
  } finally { await clean(c, records); }
});
for (const kind of ["타인 단일", "없는 ID 단일", "타인 혼합", "없는 ID 혼합"]) {
  test(`[TC-L-34] ${kind} 취소 거부와 원자성`, async ({ playwright, baseURL }) => {
    const c = await clients(playwright, baseURL); const records = [];
    try {
      const a = await create(c.alice, slot(23)); records.push(["alice", a]);
      const b = await create(c.bob, slot(23, 10)); records.push(["bob", b]);
      const target = kind.startsWith("타인") ? b.id : "missing-login-test-id";
      const response = kind.endsWith("혼합")
        ? await c.alice.post("/api/bookings/cancel", { data: { ids: [a.id, target] } })
        : await c.alice.post(`/api/bookings/${target}/cancel`);
      expect(response.status()).toBe(404);
      for (const [owner, row] of records) {
        const rows = await (await c[owner].get("/api/bookings")).json();
        expect(rows.find(r => r.id === row.id).status).toBe("confirmed");
      }
    } finally { await clean(c, records); }
  });
}
