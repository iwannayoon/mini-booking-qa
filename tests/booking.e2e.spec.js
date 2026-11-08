import { test, expect } from "@playwright/test";

async function login(page, username = "alice", password = "demo1234") {
  await page.goto("/");
  await page.getByLabel("계정").fill(username);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
}

const pick = (page, time) =>
  page.getByRole("button", { name: time + " 선택", exact: true });

// TC-B E2E 케이스. D는 테스트 시작 시 계산한 KST 내일이며, 생성한 예약·잠금은 finally에서 정리합니다.
// 취소 이력 표시를 보는 케이스는 다른 테스트의 취소 이력과 묶이지 않도록 전용 날짜를 씁니다.
import { apiLogin, date } from "./helpers/login.js";
import { client, create, rows, cancelSlots } from "./helpers/booking.js";

const at = (day, hour) => `${day}T${String(hour).padStart(2, "0")}:00:00+09:00`;
const hours = Array.from({ length: 9 }, (_, i) => `${String(9 + i).padStart(2, "0")}:00`);
const reserve = (page) => page.locator("button.reserve");
const summary = (page) => page.getByRole("region", { name: "예약 요약" });
const field = (page, label) =>
  summary(page).locator("dl > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd");
const card = (page, text, status = "confirmed") =>
  page.locator(status === "cancelled" ? "article.cancelled" : "article:not(.cancelled)").filter({ hasText: text });
const isCall = (method, path) => (r) =>
  r.request().method() === method && new URL(r.url()).pathname === path;
const confirmedOn = async (client, value) =>
  (await rows(client)).filter((r) => r.slot === value && r.status === "confirmed");

// 화면 로그인 후 슬롯 목록이 그려질 때까지 기다립니다.
async function open(page, name = "alice") {
  await login(page, name);
  await expect(pick(page, "09:00")).toBeVisible();
}
// API로 로그인해 둔 세션으로 화면을 엽니다(사전 데이터 준비 후 사용).
async function resume(page) {
  await page.goto("/");
  await expect(pick(page, "09:00")).toBeVisible();
}
// 날짜 입력으로 이동하고 해당 날짜 슬롯 조회 응답을 기다립니다.
async function moveTo(page, value) {
  const loaded = page.waitForResponse((r) => r.url().includes(`/api/slots?date=${value}`));
  await page.getByLabel("예약 날짜").fill(value);
  await loaded;
}

test.describe("TC-B 예약 화면", () => {
  test.afterEach(async ({ page }) => {
    await page.request.post("/api/logout");
  });

  test("[TC-B-02] 초기 날짜·슬롯 목록과 가용성 표시", async ({ page, playwright, baseURL }) => {
    const D = date(1);
    const bob = await client(playwright, baseURL, "bob"), admin = await client(playwright, baseURL, "admin");
    try {
      await create(bob, { slot: at(D, 10) });
      expect((await admin.put("/api/admin/slots", { data: { slot: at(D, 11), blocked: true } })).status()).toBe(200);
      await open(page);
      await test.step("A 기본 날짜는 KST 내일, 09~17시 슬롯 9개", async () => {
        await expect(page.getByLabel("예약 날짜")).toHaveValue(D);
        await expect(page.locator(".slots button[aria-pressed]")).toHaveCount(9);
        for (const hour of hours) await expect(pick(page, hour)).toBeVisible();
      });
      await test.step("B 빈 슬롯만 선택 가능, 예약·잠금 슬롯은 비활성", async () => {
        await expect(pick(page, "09:00")).toBeEnabled();
        await expect(pick(page, "09:00")).toContainText("예약 가능");
        await expect(pick(page, "10:00")).toBeDisabled();
        await expect(pick(page, "10:00")).toContainText("예약 불가");
        await expect(pick(page, "11:00")).toBeDisabled();
        await expect(pick(page, "11:00")).toContainText("잠금");
      });
      await test.step("C 시간 범위 밖 날짜는 모든 슬롯 비활성", async () => {
        for (const value of [date(-1), date(31)]) {
          await moveTo(page, value);
          await expect(page.locator(".slots button[aria-pressed]")).toHaveCount(9);
          for (const hour of hours) await expect(pick(page, hour), `${value} ${hour}`).toBeDisabled();
        }
      });
    } finally {
      await admin.put("/api/admin/slots", { data: { slot: at(D, 11), blocked: false } });
      await cancelSlots(bob, [at(D, 10)]);
      await bob.dispose(); await admin.dispose();
    }
  });

  for (const combo of ["A 선택 없음", "B 09·10시 선택 후 09시 해제", "C 모두 해제", "D 확정 요청 보류"]) {
    test(`[TC-B-04] ${combo}`, async ({ page }) => {
      const D = date(1);
      // 선택만으로 생성 요청이 나가지 않는지 확인하기 위해 POST를 기록합니다.
      const posts = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && new URL(r.url()).pathname === "/api/bookings") posts.push(r);
      });
      try {
        await open(page);
        if (combo.startsWith("A")) {
          for (const hour of hours) await expect(pick(page, hour)).toHaveAttribute("aria-pressed", "false");
          await expect(reserve(page)).toBeDisabled();
        } else if (combo.startsWith("B")) {
          await pick(page, "09:00").click(); await pick(page, "10:00").click();
          await expect(pick(page, "09:00")).toHaveAttribute("aria-pressed", "true");
          await expect(pick(page, "10:00")).toHaveAttribute("aria-pressed", "true");
          await pick(page, "09:00").click();
          await expect(pick(page, "09:00")).toHaveAttribute("aria-pressed", "false");
          await expect(pick(page, "10:00")).toHaveAttribute("aria-pressed", "true");
          await expect(reserve(page)).toBeEnabled();
        } else if (combo.startsWith("C")) {
          for (const hour of ["09:00", "10:00", "09:00", "10:00"]) await pick(page, hour).click();
          for (const hour of ["09:00", "10:00"]) await expect(pick(page, hour)).toHaveAttribute("aria-pressed", "false");
          await expect(reserve(page)).toBeDisabled();
        } else {
          // 생성 POST만 보류하고 조회 요청은 그대로 통과시킵니다.
          let release, entered;
          const gate = new Promise((resolve) => { release = resolve; });
          const seen = new Promise((resolve) => { entered = resolve; });
          await page.route("**/api/bookings", async (route) => {
            if (route.request().method() !== "POST") return route.fallback();
            entered(); await gate; await route.continue();
          });
          await pick(page, "09:00").click();
          await reserve(page).click(); await seen;
          await expect(reserve(page)).toBeDisabled();
          await expect(reserve(page)).toHaveText("처리 중…");
          await expect(pick(page, "09:00")).toBeDisabled();
          const created = page.waitForResponse(isCall("POST", "/api/bookings"));
          release();
          expect((await created).status()).toBe(201);
          await expect(page.getByRole("status")).toHaveText("예약이 완료되었습니다.");
          expect(posts).toHaveLength(1);
          return;
        }
        expect(posts).toHaveLength(0);
        expect(await confirmedOn(page.request, at(D, 9))).toHaveLength(0);
        expect(await confirmedOn(page.request, at(D, 10))).toHaveLength(0);
      } finally {
        await cancelSlots(page.request, [at(D, 9), at(D, 10)]);
      }
    });
  }

  for (const [combo, selection, ranges, total, price] of [
    ["A 09시 단일", ["09:00"], ["09:00–10:00"], "1시간", "10,000원"],
    ["B 09·10·12시 비연속", ["09:00", "10:00", "12:00"], ["09:00–11:00", "12:00–13:00"], "3시간", "30,000원"],
  ]) {
    test(`[TC-B-05] ${combo} 요약과 데모 금액`, async ({ page }) => {
      const D = date(1);
      await open(page);
      for (const hour of selection) await pick(page, hour).click();
      await expect(field(page, "이용 공간")).toHaveText("포커스 룸");
      await expect(field(page, "예약 일시")).toContainText(D);
      await expect(summary(page).locator(".time-range")).toHaveText(ranges);
      await expect(field(page, "총 예약 시간")).toHaveText(total);
      await expect(field(page, "시간당 요금")).toHaveText("10,000원");
      await expect(field(page, "결제 금액")).toHaveText(price);
      await expect(summary(page)).toContainText("데모 요금이며 실제 결제는 발생하지 않습니다.");
    });
  }

  for (const combo of ["A 선택 없이 이동", "B 모달에서 돌아가기", "C 모달에서 확인"]) {
    test(`[TC-B-06] ${combo}`, async ({ page }) => {
      const D = date(1), next = date(2);
      const input = page.getByLabel("예약 날짜");
      await open(page);
      if (combo.startsWith("A")) {
        await moveTo(page, next);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(input).toHaveValue(next);
        return;
      }
      await pick(page, "09:00").click();
      await input.fill(next);
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("선택한 1시간이 초기화됩니다.");
      if (combo.startsWith("B")) {
        await dialog.getByRole("button", { name: "돌아가기" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(input).toHaveValue(D);
        await expect(pick(page, "09:00")).toHaveAttribute("aria-pressed", "true");
        await expect(summary(page).locator(".time-range")).toHaveText(["09:00–10:00"]);
      } else {
        const loaded = page.waitForResponse((r) => r.url().includes(`/api/slots?date=${next}`));
        await dialog.getByRole("button", { name: "선택 초기화하고 이동" }).click();
        await loaded;
        await expect(input).toHaveValue(next);
        await expect(pick(page, "09:00")).toHaveAttribute("aria-pressed", "false");
        await expect(summary(page)).toContainText("이용할 시간을 선택하면");
        await expect(reserve(page)).toBeDisabled();
      }
    });
  }

  test("[TC-B-11] 두 사용자 선택 유지와 확정 시 충돌", async ({ page, browser, baseURL }) => {
    const D = date(1), S = at(D, 15);
    const bobContext = await browser.newContext({ baseURL });
    const bobPage = await bobContext.newPage();
    try {
      await open(page); await open(bobPage, "bob");
      // 선택만으로는 서버에 점유되지 않으므로 두 사용자 모두 선택할 수 있습니다.
      await pick(page, "15:00").click(); await pick(bobPage, "15:00").click();
      await expect(pick(page, "15:00")).toHaveAttribute("aria-pressed", "true");
      await expect(pick(bobPage, "15:00")).toHaveAttribute("aria-pressed", "true");
      const created = page.waitForResponse(isCall("POST", "/api/bookings"));
      await reserve(page).click();
      expect((await created).status()).toBe(201);
      await expect(page.getByRole("status")).toHaveText("예약이 완료되었습니다.");
      // 실시간 갱신은 요구하지 않으므로 bob 화면은 기존 선택을 유지합니다.
      await expect(pick(bobPage, "15:00")).toHaveAttribute("aria-pressed", "true");
      const rejected = bobPage.waitForResponse(isCall("POST", "/api/bookings"));
      await reserve(bobPage).click();
      expect((await rejected).status()).toBe(409);
      await expect(bobPage.getByRole("status")).toHaveText("선택한 시간 중 이미 예약된 시간이 있습니다. 다시 선택해 주세요.");
      await expect(pick(bobPage, "15:00")).toHaveAttribute("aria-pressed", "true");
      await expect(summary(bobPage).locator(".time-range")).toHaveText(["15:00–16:00"]);
      await expect(reserve(bobPage)).toBeEnabled();
      await expect(reserve(bobPage)).toHaveText("예약 확정하기");
      expect(await confirmedOn(page.request, S)).toHaveLength(1);
      expect(await confirmedOn(bobPage.request, S)).toHaveLength(0);
    } finally {
      await cancelSlots(page.request, [S]); await cancelSlots(bobPage.request, [S]);
      await bobPage.request.post("/api/logout");
      await bobContext.close();
    }
  });

  test("[TC-B-12] 예약 성공 후 화면 갱신", async ({ page }) => {
    const D = date(1);
    try {
      await open(page);
      await pick(page, "09:00").click(); await pick(page, "10:00").click();
      await expect(summary(page).locator(".time-range")).toHaveText(["09:00–11:00"]);
      const created = page.waitForResponse(isCall("POST", "/api/bookings"));
      await reserve(page).click();
      expect((await created).status()).toBe(201);
      await expect(page.getByRole("status")).toHaveText("예약이 완료되었습니다.");
      // 선택이 초기화되고 예약한 슬롯은 예약 불가로 갱신됩니다.
      await expect(reserve(page)).toBeDisabled();
      await expect(summary(page)).toContainText("이용할 시간을 선택하면");
      for (const hour of ["09:00", "10:00"]) {
        await expect(pick(page, hour)).toBeDisabled();
        await expect(pick(page, hour)).toContainText("예약 불가");
      }
      const booked = card(page, `${D} · 09:00–11:00`);
      await expect(booked).toHaveCount(1);
      await expect(booked).toContainText("총 2시간");
    } finally {
      await cancelSlots(page.request, [at(D, 9), at(D, 10)]);
    }
  });

  for (const [combo, fail, message] of [
    ["A 503 응답", (route) => route.fulfill({ status: 503, json: { error: "잠시 후 다시 시도해 주세요." } }), "잠시 후 다시 시도해 주세요."],
    ["B 네트워크 실패", (route) => route.abort("failed"), "연결에 문제가 발생했습니다."],
  ]) {
    test(`[TC-B-13] ${combo} 시 선택·요약 보존과 재확정`, async ({ page }) => {
      const D = date(1);
      try {
        await open(page);
        // 생성 POST만 장애로 대체하고 조회 API는 실제 서버를 사용합니다.
        await page.route("**/api/bookings", (route) =>
          route.request().method() === "POST" ? fail(route) : route.fallback());
        await pick(page, "14:00").click();
        await reserve(page).click();
        await expect(page.getByRole("status")).toHaveText(message);
        await expect(pick(page, "14:00")).toHaveAttribute("aria-pressed", "true");
        await expect(summary(page).locator(".time-range")).toHaveText(["14:00–15:00"]);
        await expect(field(page, "결제 금액")).toHaveText("10,000원");
        await expect(reserve(page)).toBeEnabled();
        await expect(reserve(page)).toHaveText("예약 확정하기");
        // 장애 해제 후 같은 선택으로 다시 확정할 수 있어야 합니다.
        await page.unroute("**/api/bookings");
        const created = page.waitForResponse(isCall("POST", "/api/bookings"));
        await reserve(page).click();
        expect((await created).status()).toBe(201);
        await expect(page.getByRole("status")).toHaveText("예약이 완료되었습니다.");
      } finally {
        await cancelSlots(page.request, [at(D, 14)]);
      }
    });
  }

  for (const [combo, path] of [["A 슬롯 조회 실패", "/api/slots"], ["B 내 예약 조회 실패", "/api/bookings"]]) {
    test(`[TC-B-14] 생성 성공 후 ${combo}`, async ({ page }) => {
      const D = date(1), S = at(D, 13);
      const posts = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && new URL(r.url()).pathname === "/api/bookings") posts.push(r);
      });
      try {
        await open(page);
        // 초기 조회가 끝난 뒤 설치하여, 생성 직후 첫 GET 한 번만 실패시킵니다.
        let failed = false;
        const target = (url) => url.pathname === path;
        await page.route(target, (route) => {
          if (route.request().method() !== "GET" || failed) return route.fallback();
          failed = true;
          return route.fulfill({ status: 503, json: { error: "일시적인 오류입니다." } });
        });
        await pick(page, "13:00").click();
        const created = page.waitForResponse(isCall("POST", "/api/bookings"));
        await reserve(page).click();
        expect((await created).status()).toBe(201);
        await expect(page.getByRole("status")).toHaveText("예약이 완료되었습니다. 목록을 새로고침해 주세요.");
        expect(failed).toBe(true);
        await page.unroute(target);
        await resume(page);
        // 재조회하면 실제 예약이 1건만 존재하며 자동 재요청은 없습니다.
        await expect(card(page, `${D} · 13:00–14:00`)).toHaveCount(1);
        await expect(pick(page, "13:00")).toBeDisabled();
        expect(await confirmedOn(page.request, S)).toHaveLength(1);
        expect(posts).toHaveLength(1);
      } finally {
        await cancelSlots(page.request, [S]);
      }
    });
  }

  test("[TC-B-15] 본인 예약 이력 묶음과 새로고침", async ({ page, playwright, baseURL }) => {
    const X = date(4), Y = date(5);
    const bob = await client(playwright, baseURL, "bob");
    const mine = [at(X, 9), at(X, 10), at(X, 12), at(X, 14), at(X, 15), at(Y, 9)];
    try {
      await apiLogin(page.request);
      await create(page.request, { slots: [at(X, 9), at(X, 10), at(X, 12)] });
      const cancelled = await create(page.request, { slots: [at(X, 14), at(X, 15)] });
      expect((await page.request.post("/api/bookings/cancel", { data: { ids: cancelled.map((r) => r.id) } })).status()).toBe(200);
      await create(page.request, { slot: at(Y, 9) });
      await create(bob, { slot: at(X, 16) });
      const verify = async () => {
        await expect(page.locator("article").filter({ hasText: X })).toHaveCount(3);
        await expect(card(page, `${X} · 09:00–11:00`)).toContainText("총 2시간");
        await expect(card(page, `${X} · 12:00–13:00`)).toContainText("총 1시간");
        const history = card(page, `${X} · 14:00–16:00`, "cancelled");
        await expect(history).toContainText("취소됨");
        await expect(history).toContainText("총 2시간");
        await expect(card(page, `${Y} · 09:00–10:00`)).toHaveCount(1);
        // bob의 X 16시 예약은 표시되지 않습니다.
        await expect(page.locator("article").filter({ hasText: "16:00–17:00" })).toHaveCount(0);
        const stored = await rows(page.request);
        for (const value of mine)
          expect(stored.find((r) => r.slot === value)?.status, value).toBe(value.includes("T14") || value.includes("T15") ? "cancelled" : "confirmed");
      };
      await resume(page); await verify();
      await page.reload(); await expect(pick(page, "09:00")).toBeVisible(); await verify();
    } finally {
      await cancelSlots(page.request, mine); await cancelSlots(bob, [at(X, 16)]);
      await bob.dispose();
    }
  });

  for (const combo of ["A 돌아가기", "B 취소 확인 성공", "C 취소 API 503"]) {
    test(`[TC-B-16] ${combo}`, async ({ page }) => {
      const D = date(1), pair = [at(D, 9), at(D, 10)], other = at(D, 16);
      try {
        await apiLogin(page.request);
        const ids = (await create(page.request, { slots: pair })).map((r) => r.id);
        const otherRow = await create(page.request, { slot: other });
        await resume(page);
        if (combo.startsWith("C"))
          await page.route("**/api/bookings/cancel", (route) =>
            route.fulfill({ status: 503, json: { error: "잠시 후 다시 시도해 주세요." } }));
        await card(page, `${D} · 09:00–11:00`).getByRole("button", { name: "예약 취소" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText(`${D} · 09:00–11:00`);
        await expect(dialog).toContainText("총 2시간");
        await expect(dialog).toContainText("이 예약 내역의 모든 시간이 취소됩니다.");
        let expected = "confirmed";
        if (combo.startsWith("A")) {
          await dialog.getByRole("button", { name: "돌아가기" }).click();
          await expect(dialog).toHaveCount(0);
        } else if (combo.startsWith("B")) {
          const cancelled = page.waitForResponse(isCall("POST", "/api/bookings/cancel"));
          await dialog.getByRole("button", { name: "취소하기", exact: true }).click();
          expect((await cancelled).status()).toBe(200);
          await expect(dialog).toHaveCount(0);
          await expect(page.getByRole("status")).toHaveText("예약을 취소했습니다.");
          expected = "cancelled";
        } else {
          await dialog.getByRole("button", { name: "취소하기", exact: true }).click();
          // 오류는 모달 안에 표시되고 모달은 유지됩니다.
          await expect(dialog.getByRole("alert")).toHaveText("잠시 후 다시 시도해 주세요.");
          await expect(dialog.getByRole("button", { name: "취소하기", exact: true })).toBeEnabled();
          await dialog.getByRole("button", { name: "돌아가기" }).click();
        }
        const stored = await rows(page.request);
        for (const id of ids) expect(stored.find((r) => r.id === id).status).toBe(expected);
        // 다른 카드의 예약은 변경되지 않습니다.
        expect(stored.find((r) => r.id === otherRow.id).status).toBe("confirmed");
      } finally {
        await cancelSlots(page.request, [...pair, other]);
      }
    });
  }

  for (const [combo, hour] of [["A 취소 후 재예약", 9], ["B 취소 후 관리자 잠금", 11]]) {
    test(`[TC-B-20] ${combo}`, async ({ page, playwright, baseURL }) => {
      const Z = date(29), S = at(Z, hour);
      const time = `${String(hour).padStart(2, "0")}:00`;
      const label = `${Z} · ${time}–${String(hour + 1).padStart(2, "0")}:00`;
      const admin = await client(playwright, baseURL, "admin");
      try {
        await apiLogin(page.request);
        const original = await create(page.request, { slot: S });
        await resume(page);
        await card(page, label).getByRole("button", { name: "예약 취소" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "취소하기", exact: true }).click();
        await expect(page.getByRole("status")).toHaveText("예약을 취소했습니다.");
        // 일시(h3)와 공간·총 시간(p)이 회색 취소선으로 표시됩니다.
        const details = card(page, label, "cancelled").locator(".booking-details");
        await expect(details).toHaveCount(2);
        for (const element of await details.all()) {
          await expect(element).toHaveCSS("text-decoration-line", "line-through");
          await expect(element).toHaveCSS("color", "rgb(148, 153, 148)");
        }
        if (combo.startsWith("A")) {
          await moveTo(page, Z);
          await pick(page, time).click();
          const created = page.waitForResponse(isCall("POST", "/api/bookings"));
          await reserve(page).click();
          expect((await created).status()).toBe(201);
          await expect(card(page, label)).toHaveCount(1);
          await expect(card(page, label, "cancelled")).toHaveCount(1);
          const stored = await rows(page.request);
          expect(stored.find((r) => r.id === original.id).status).toBe("cancelled");
          expect(stored.filter((r) => r.slot === S && r.status === "confirmed")).toHaveLength(1);
        } else {
          expect((await admin.put("/api/admin/slots", { data: { slot: S, blocked: true } })).status()).toBe(200);
          // 실시간 갱신을 가정하지 않고 다시 조회합니다.
          await resume(page); await moveTo(page, Z);
          await expect(pick(page, time)).toBeDisabled();
          await expect(pick(page, time)).toContainText("잠금");
          expect((await page.request.post("/api/bookings", { data: { slot: S } })).status()).toBe(409);
        }
      } finally {
        await admin.put("/api/admin/slots", { data: { slot: S, blocked: false } });
        await cancelSlots(page.request, [S]);
        await admin.dispose();
      }
    });
  }

  test("[TC-B-21] 관리자 버튼과 슬롯 잠금·해제", async ({ page, browser, baseURL }) => {
    const D = date(1), S = at(D, 17);
    const contexts = [], pages = {};
    try {
      for (const name of ["bob", "admin"]) {
        const context = await browser.newContext({ baseURL });
        contexts.push(context);
        pages[name] = await context.newPage();
        await open(pages[name], name);
      }
      await open(page);
      const adminPage = pages.admin;
      await test.step("A 잠금·해제 버튼은 관리자에게만 표시", async () => {
        await expect(page.locator(".lock")).toHaveCount(0);
        await expect(pages.bob.locator(".lock")).toHaveCount(0);
        await expect(adminPage.locator(".lock")).toHaveCount(9);
      });
      await test.step("B 관리자 잠금 후 일반 사용자 예약 불가", async () => {
        const locked = adminPage.waitForResponse(isCall("PUT", "/api/admin/slots"));
        await adminPage.getByRole("button", { name: "17:00 잠금", exact: true }).click();
        expect((await locked).status()).toBe(200);
        await expect(adminPage.getByRole("button", { name: "17:00 잠금 해제", exact: true })).toBeVisible();
        await resume(page);
        await expect(pick(page, "17:00")).toBeDisabled();
        await expect(pick(page, "17:00")).toContainText("잠금");
        expect((await page.request.post("/api/bookings", { data: { slot: S } })).status()).toBe(409);
      });
      await test.step("C 관리자 해제 후 일반 사용자 예약 성공", async () => {
        const unlocked = adminPage.waitForResponse(isCall("PUT", "/api/admin/slots"));
        await adminPage.getByRole("button", { name: "17:00 잠금 해제", exact: true }).click();
        expect((await unlocked).status()).toBe(200);
        await resume(page);
        await pick(page, "17:00").click();
        const created = page.waitForResponse(isCall("POST", "/api/bookings"));
        await reserve(page).click();
        expect((await created).status()).toBe(201);
      });
    } finally {
      await pages.admin?.request.put("/api/admin/slots", { data: { slot: S, blocked: false } });
      await cancelSlots(page.request, [S]);
      for (const p of Object.values(pages)) await p.request.post("/api/logout");
      for (const context of contexts) await context.close();
    }
  });
});
