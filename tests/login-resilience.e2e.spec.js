import { test, expect } from "@playwright/test";
import { apiLogin, uiLogin, fillLogin, loggedIn, loginButton, notice, invalidCredentials, hold, date, slot } from "./helpers/login.js";

const NETWORK = "연결에 문제가 발생했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.";
const TIMEOUT = "응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.";
const SERVER = "로그인 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
const SESSION = "로그인 상태를 확인하지 못했습니다. 다시 시도해 주세요.";
const LOGOUT = "로그아웃 완료를 확인하지 못했습니다. 다시 시도해 주세요.";
const EXPIRED = "로그인이 필요합니다. 다시 로그인해 주세요.";
const AUTH = "계정 또는 비밀번호를 확인해 주세요.";

// A controlled transport can deliver an old completion even after AbortSignal.
// It is installed in tests only. The production timeout and request handlers stay intact.
async function controlled(page, path = "/api/login") {
  await page.evaluate((path) => {
    const native = window.fetch.bind(window);
    window.pendingRequests = [];
    window.fetch = (url, options) => {
      if (new URL(url, location.href).pathname !== path) return native(url, options);
      return new Promise((resolve, reject) => {
        window.pendingRequests.push({ resolve, reject, url, options,
          real: () => native(url, options).then(resolve, reject) });
      });
    };
  }, path);
}
async function count(page, value) {
  await expect.poll(() => page.evaluate(() => window.pendingRequests.length)).toBe(value);
}
async function finish(page, index = 0, spec = { real: true }) {
  await page.evaluate(async ({ index, spec }) => {
    const req = window.pendingRequests[index];
    if (spec.real) await req.real();
    else if (spec.network) req.reject(new TypeError("Failed to fetch: internal detail"));
    else req.resolve(new Response(spec.raw ?? JSON.stringify(spec.body), {
      status: spec.status ?? 200, headers: { "Content-Type": "application/json" },
    }));
  }, { index, spec });
}
async function open(page) {
  await page.goto("/");
  await expect(loginButton(page)).toBeEnabled();
}
async function freeze(page) {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
}
async function submit(page, password = "demo1234") {
  await fillLogin(page, "alice", password);
  await loginButton(page).click();
}
async function recovery(page, message) {
  await expect(notice(page)).toHaveText(message);
  await expect(loginButton(page)).toHaveText("로그인");
  await expect(loginButton(page)).toBeEnabled();
  await expect(page.getByLabel("계정", { exact: true })).toHaveValue("alice");
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveValue("demo1234");
  await expect(page.locator(".columns")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toHaveCount(0);
}
test.afterEach(async ({ page }) => {
  await page.request.post("/api/logout");
});

for (const name of ["alice", "bob", "admin"]) {
  test(`[TC-L-08] ${name} 정상 화면 전환`, async ({ page }) => {
    await open(page); await uiLogin(page, name); await loggedIn(page, name);
  });
}
for (const [label, username, password] of invalidCredentials) {
  test(`[TC-L-10] ${label} 화면 오류 안내`, async ({ page }) => {
    await open(page); await fillLogin(page, username, password);
    const response = page.waitForResponse(r => r.url().endsWith("/api/login") && r.request().method() === "POST");
    await loginButton(page).click(); expect((await response).status()).toBe(401);
    await expect(notice(page)).toHaveText(AUTH);
    await expect(page.locator(".login")).toBeVisible();
    await expect(page.getByRole("button", { name: "로그아웃" })).toHaveCount(0);
    await expect(page.locator(".columns")).toHaveCount(0);
  });
}
for (const mode of ["비활성 버튼", "Enter", "requestSubmit"]) {
  test(`[TC-L-12] ${mode} 중복 제출 차단`, async ({ page }) => {
    await open(page); await controlled(page); await submit(page); await count(page, 1);
    await expect(loginButton(page)).toBeDisabled();
    await expect(loginButton(page)).toHaveText("로그인 중…");
    if (mode === "비활성 버튼") {
      const box = await loginButton(page).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else if (mode === "Enter") {
      await page.getByLabel("비밀번호", { exact: true }).press("Enter");
      await page.getByLabel("비밀번호", { exact: true }).press("Enter");
    } else await page.locator("form").evaluate(f => { f.requestSubmit(); f.requestSubmit(); });
    await count(page, 1); await expect(page.locator(".login")).toBeVisible();
    await finish(page, 0, { network: true }); await expect(loginButton(page)).toBeEnabled();
  });
}
test("[TC-L-13] 처리 중에서 실제 로그인 성공으로 전환", async ({ page }) => {
  await open(page); await controlled(page); await submit(page); await count(page, 1);
  await expect(loginButton(page)).toBeDisabled(); await expect(loginButton(page)).toHaveText("로그인 중…");
  await finish(page); await loggedIn(page);
});
test("[TC-L-14] 인증 실패 후 버튼 복원과 성공 재시도", async ({ page }) => {
  await open(page); await controlled(page); await submit(page, "wrong"); await count(page, 1);
  await expect(loginButton(page)).toBeDisabled(); await expect(loginButton(page)).toHaveText("로그인 중…");
  await finish(page);
  await expect(notice(page)).toHaveText(AUTH); await expect(loginButton(page)).toBeEnabled();
  await expect(loginButton(page)).toHaveText("로그인");
  await submit(page); await count(page, 2); await finish(page, 1); await loggedIn(page);
});
for (const [label, username, password] of [["A", "", ""], ["B", "", "demo1234"], ["C", "alice", ""], ["D", "   ", "demo1234"]]) {
  test(`[TC-L-15] ${label} 필수 입력 오류에서 처리 중 상태 미진입`, async ({ page }) => {
    await open(page); await controlled(page); await fillLogin(page, username, password);
    await loginButton(page).evaluate(button => {
      window.buttonStates = [];
      window.buttonObserver = new MutationObserver(records => {
        window.buttonStates.push(...records.map(r => ({ old: r.oldValue, disabled: button.disabled, text: button.textContent })));
      });
      window.buttonObserver.observe(button, { attributes: true, attributeOldValue: true, childList: true, subtree: true, characterData: true, characterDataOldValue: true });
    });
    await loginButton(page).click();
    // A는 두 항목, B·D는 계정, C는 비밀번호 오류만 표시되어야 합니다.
    await expect(page.locator("#username-error")).toHaveCount(username.trim() ? 0 : 1);
    await expect(page.locator("#password-error")).toHaveCount(password ? 0 : 1);
    await expect(loginButton(page)).toBeEnabled(); await expect(loginButton(page)).toHaveText("로그인"); await count(page, 0);
    expect(await page.evaluate(() => window.buttonStates.some(s => s.disabled || s.text.includes("로그인 중") || String(s.old).includes("로그인 중")))).toBe(false);
  });
}
test("[TC-L-16] 네트워크 실패 안내·입력 유지·버튼 복구", async ({ page }) => {
  await open(page); await controlled(page); await submit(page); await count(page, 1);
  await expect(loginButton(page)).toBeDisabled(); await finish(page, 0, { network: true }); await recovery(page, NETWORK);
});
test("[TC-L-17] 네트워크 복구 후 자동 재요청 없음과 사용자 재시도", async ({ page }) => {
  await open(page); await freeze(page); await controlled(page); await submit(page); await count(page, 1);
  await finish(page, 0, { network: true }); await recovery(page, NETWORK);
  await page.clock.runFor(30000); await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await count(page, 1); await loginButton(page).click(); await count(page, 2);
  expect(await page.evaluate(() => JSON.parse(window.pendingRequests[1].options.body))).toEqual({ username: "alice", password: "demo1234" });
  await finish(page, 1); await loggedIn(page);
});
test("[TC-L-18] 9,999ms 대기 후 10,000ms 시간 초과", async ({ page }) => {
  await open(page); await freeze(page); await controlled(page); await submit(page); await count(page, 1);
  await page.clock.runFor(9999); await expect(loginButton(page)).toBeDisabled();
  await expect(loginButton(page)).toHaveText("로그인 중…"); await expect(notice(page)).toBeEmpty();
  await page.clock.runFor(1); await recovery(page, TIMEOUT); await count(page, 1);
});
test("[TC-L-19] 9,999ms 정상 응답 후 타이머 오류 없음", async ({ page }) => {
  await open(page); await freeze(page);
  const gate = await hold(page, "**/api/login", { actual: true });
  await submit(page); await gate.seen;
  await page.clock.runFor(9999); gate.release(); await loggedIn(page);
  await page.clock.runFor(2); await loggedIn(page); await expect(notice(page)).toBeEmpty();
});
for (const [label, timing, status] of [["A", "before", 200], ["B", "during", 200], ["C", "during", 401], ["D", "after", 200], ["E", "after", 401]]) {
  test(`[TC-L-20] ${label} 늦은 ${status} 응답 (${timing}) 무시`, async ({ page }) => {
    await open(page); await freeze(page); await controlled(page); await submit(page); await count(page, 1);
    await page.clock.runFor(10000); await recovery(page, TIMEOUT);
    const old = { status, body: status === 200 ? { name: "bob", role: "user" } : { error: AUTH } };
    if (timing === "before") { await finish(page, 0, old); await recovery(page, TIMEOUT); }
    await loginButton(page).click(); await count(page, 2);
    if (timing === "during") {
      await finish(page, 0, old); await expect(loginButton(page)).toBeDisabled();
      await expect(loginButton(page)).toHaveText("로그인 중…"); await expect(notice(page)).toBeEmpty();
    }
    await finish(page, 1); await loggedIn(page);
    if (timing === "after") { await finish(page, 0, old); await loggedIn(page); await expect(notice(page)).toBeEmpty(); }
    await count(page, 2);
  });
}
const malformed = [
  ["500", { status: 500, body: { error: "INTERNAL SECRET" } }],
  ["503 HTML", { status: 503, raw: "<html>INTERNAL SECRET</html>" }],
  ["invalid JSON", { raw: "{" }], ["empty object", { body: {} }],
  ["null name", { body: { name: null, role: "user" } }],
  ["missing role", { body: { name: "alice" } }],
  ["unknown role", { body: { name: "alice", role: "unknown" } }],
];
for (const [label, response] of malformed) {
  test(`[TC-L-21] ${label} 공통 오류 안내와 재시도`, async ({ page }) => {
    await open(page); await controlled(page); await submit(page); await count(page, 1);
    await finish(page, 0, response); await recovery(page, SERVER);
    await expect(page.locator("body")).not.toContainText("INTERNAL SECRET");
    await loginButton(page).click(); await count(page, 2); await finish(page, 1); await loggedIn(page);
  });
}

for (const authenticated of [true, false]) {
  test(`[TC-L-22] 초기 세션 ${authenticated ? "복원" : "401"} 및 확인 중 차단`, async ({ page }) => {
    if (authenticated) await apiLogin(page.request);
    const gate = await hold(page, "**/api/me", { actual: true });
    await page.goto("/"); await gate.seen;
    await expect(page.getByText("로그인 상태 확인 중…", { exact: true })).toBeVisible();
    await expect(page.locator(".columns")).toHaveCount(0); await expect(loginButton(page)).toHaveCount(0);
    gate.release();
    if (authenticated) await loggedIn(page);
    else { await expect(loginButton(page)).toBeEnabled(); await expect(notice(page)).toBeEmpty(); }
    await page.unroute("**/api/me"); await page.reload();
    if (authenticated) await loggedIn(page); else await expect(loginButton(page)).toBeEnabled();
  });
}
for (const mode of ["network", "500", "format", "empty", "timeout"]) {
  test(`[TC-L-23] 초기 세션 ${mode} 장애와 재확인`, async ({ page }) => {
    await apiLogin(page.request);
    if (mode === "timeout") await freeze(page);
    let calls = 0;
    // 재확인 요청은 보류해 두고, 확인 중 화면이 잠겨 있는지 점검한 뒤 해제합니다.
    let release;
    const retry = new Promise(resolve => { release = resolve; });
    await page.route("**/api/me", async route => {
      calls++;
      if (calls > 1) { await retry; return route.continue(); }
      if (mode === "timeout") return; // abort is driven by the application's timer
      if (mode === "network") return route.abort("failed");
      await route.fulfill({ status: mode === "500" ? 500 : 200, contentType: "application/json", body: mode === "format" ? "{" : "{}" });
    });
    await page.goto("/");
    if (mode === "timeout") {
      await expect.poll(() => calls).toBe(1); await page.clock.runFor(9999);
      await expect(page.getByText("로그인 상태 확인 중…", { exact: true })).toBeVisible();
      await page.clock.runFor(1);
    }
    await expect(notice(page)).toHaveText(SESSION);
    await expect(page.locator(".columns")).toHaveCount(0); await expect(loginButton(page)).toHaveCount(0);
    await page.getByRole("button", { name: "로그인 상태 다시 확인" }).click();
    await expect.poll(() => calls).toBe(2);
    await expect(page.getByText("로그인 상태 확인 중…", { exact: true })).toBeVisible();
    await expect(page.locator(".columns")).toHaveCount(0); await expect(loginButton(page)).toHaveCount(0);
    release(); await loggedIn(page); expect(calls).toBe(2);
  });
}
async function prepareBooking(page, offset = 24) {
  const response = await page.request.post("/api/bookings", { data: { slot: slot(offset, 15) } });
  expect(response.status()).toBe(201); return response.json();
}
async function removeBooking(page, row) {
  if (!row) return;
  await apiLogin(page.request, "alice");
  await page.request.post(`/api/bookings/${row.id}/cancel`);
}
for (const trigger of ["날짜 조회", "예약 생성"]) {
  test(`[TC-L-24] ${trigger} 401에서 세션 초기화와 bob 로그인`, async ({ page }) => {
    await open(page); await uiLogin(page); const row = await prepareBooking(page);
    try {
      await page.reload(); await loggedIn(page);
      await page.getByRole("button", { name: "09:00 선택", exact: true }).click();
      await page.request.post("/api/logout");
      // 실제 보호 API가 401을 반환했는지 응답으로 확인합니다.
      const path = trigger === "예약 생성" ? "/api/bookings" : "/api/slots";
      const rejected = page.waitForResponse(r => new URL(r.url()).pathname === path && r.status() === 401);
      if (trigger === "예약 생성") await page.getByRole("button", { name: "예약 확정하기" }).click();
      else {
        await page.getByLabel("예약 날짜").fill(date(25));
        await page.getByRole("button", { name: "선택 초기화하고 이동" }).click();
      }
      await rejected;
      await expect(notice(page)).toHaveText(EXPIRED); await expect(loginButton(page)).toBeEnabled();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await uiLogin(page, "bob"); await loggedIn(page, "bob");
      await expect(page.locator(".history")).not.toContainText(date(24));
      await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
    } finally { await removeBooking(page, row); }
  });
}
for (const timing of ["로그인 화면", "bob 로그인 후"]) {
  test(`[TC-L-25] 이전 사용자 목록의 늦은 결과 (${timing})`, async ({ page }) => {
    await open(page); await uiLogin(page); const row = await prepareBooking(page, 25);
    let release;
    try {
      let seen;
      const entered = new Promise(resolve => { seen = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      let first = true;
      await page.route("**/api/bookings", async route => {
        if (!first || route.request().method() !== "GET") return route.continue();
        first = false;
        const response = await route.fetch(); seen(); await gate;
        await route.fulfill({ response });
      });
      await page.getByLabel("예약 날짜").fill(date(25)); await entered;
      await page.request.post("/api/logout");
      await page.getByLabel("예약 날짜").fill(date(26));
      await expect(notice(page)).toHaveText(EXPIRED);
      if (timing === "bob 로그인 후") await uiLogin(page, "bob");
      const delivered = page.waitForResponse(r => r.url().endsWith("/api/bookings") && r.status() === 200);
      release(); await delivered;
      if (timing === "bob 로그인 후") { await loggedIn(page, "bob"); await expect(page.locator(".history")).not.toContainText(date(25)); }
      else { await expect(loginButton(page)).toBeEnabled(); await expect(page.locator(".columns")).toHaveCount(0); }
    } finally { release?.(); await removeBooking(page, row); }
  });
}
for (const mode of ["선택 있음", "모달 닫은 후"]) {
  test(`[TC-L-27] ${mode} 로그아웃 차단·초기화·예약 보존`, async ({ page }) => {
    await open(page); await uiLogin(page); const row = await prepareBooking(page, 26);
    let gate;
    try {
      await page.reload(); await loggedIn(page);
      await page.getByRole("button", { name: "09:00 선택", exact: true }).click();
      if (mode === "모달 닫은 후") {
        await page.getByLabel("예약 날짜").fill(date(25));
        await page.getByRole("button", { name: "돌아가기" }).click();
      }
      gate = await hold(page, "**/api/logout");
      const logout = page.getByRole("button", { name: "로그아웃", exact: true });
      await logout.click(); await gate.seen; await expect(logout).toBeDisabled();
      const box = await logout.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      expect(gate.count()).toBe(1); gate.release(); await expect(loginButton(page)).toBeEnabled();
      await page.unroute("**/api/logout"); await page.reload(); await expect(loginButton(page)).toBeEnabled();
      await uiLogin(page, "bob"); await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
      await expect(page.locator(".history")).not.toContainText(date(26)); await expect(page.getByRole("dialog")).toHaveCount(0);
      await apiLogin(page.request, "alice");
      const rows = await (await page.request.get("/api/bookings")).json();
      expect(rows.find(r => r.id === row.id).status).toBe("confirmed");
    } finally { gate?.release(); await page.unroute("**/api/logout"); await removeBooking(page, row); }
  });
}
for (const mode of ["network", "timeout", "500", "format", "empty"]) {
  test(`[TC-L-29] 로그아웃 ${mode} 장애 후 재시도`, async ({ page }) => {
    await open(page); await uiLogin(page); await freeze(page); await controlled(page, "/api/logout");
    const logout = page.getByRole("button", { name: "로그아웃", exact: true });
    await logout.click(); await count(page, 1); await expect(logout).toBeDisabled();
    if (mode === "timeout") {
      await page.clock.runFor(9999); await expect(logout).toBeDisabled(); await expect(notice(page)).toBeEmpty();
      await page.clock.runFor(1);
    } else await finish(page, 0, mode === "network" ? { network: true } : mode === "500" ? { status: 500, body: {} } : mode === "format" ? { raw: "{" } : { body: {} });
    await expect(notice(page)).toHaveText(LOGOUT); await loggedIn(page); await expect(logout).toBeEnabled();
    await logout.click(); await count(page, 2); await finish(page, 1); await expect(loginButton(page)).toBeEnabled();
  });
}
for (const action of ["보호 API", "로그아웃 재시도"]) {
  test(`[TC-L-30] 서버 처리 후 응답 유실 → ${action}`, async ({ page }) => {
    await open(page); await uiLogin(page);
    let first = true;
    await page.route("**/api/logout", async route => {
      if (!first) return route.continue(); first = false;
      const res = await route.fetch(); expect(res.status()).toBe(200);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(notice(page)).toHaveText(LOGOUT); await loggedIn(page);
    expect((await page.request.get("/api/me")).status()).toBe(401);
    if (action === "보호 API") {
      await page.getByLabel("예약 날짜").fill(date(27)); await expect(notice(page)).toHaveText(EXPIRED);
    } else {
      // 세션이 이미 없어도 재시도는 200과 {"ok":true}를 받아야 합니다.
      const retried = page.waitForResponse(r => r.url().endsWith("/api/logout") && r.request().method() === "POST");
      await page.getByRole("button", { name: "로그아웃", exact: true }).click();
      const response = await retried;
      expect(response.status()).toBe(200); expect(await response.json()).toEqual({ ok: true });
    }
    await expect(loginButton(page)).toBeEnabled();
  });
}
