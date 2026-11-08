import { expect } from "@playwright/test";
export const invalidCredentials = [
  ["A 없는 계정", "unknown-user", "demo1234"],
  ["B 잘못된 비밀번호", "alice", "wrong"],
  ["C 계정 대소문자", "Alice", "demo1234"],
  ["D 계정 앞 공백", " alice", "demo1234"],
  ["E 계정 뒤 공백", "alice ", "demo1234"],
  ["F 비밀번호 대소문자", "alice", "Demo1234"],
  ["G 비밀번호 앞 공백", "alice", " demo1234"],
  ["H 비밀번호 뒤 공백", "alice", "demo1234 "],
];
export const date = (offset = 20) => new Date(Date.now() + offset * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
export const slot = (offset = 20, hour = 9) => `${date(offset)}T${String(hour).padStart(2, "0")}:00:00+09:00`;
export async function apiLogin(client, name = "alice") {
  const res = await client.post("/api/login", { data: { username: name, password: "demo1234" } });
  expect(res.status()).toBe(200);
  return res;
}
export async function fillLogin(page, name = "alice", password = "demo1234") {
  await page.getByLabel("계정", { exact: true }).fill(name);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
}
export async function uiLogin(page, name = "alice") {
  await fillLogin(page, name);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
}
export const notice = (page) => page.locator(".notice");
export const loginButton = (page) => page.locator(".login button.primary");
export async function loggedIn(page, name = "alice") {
  await expect(page.locator("header")).toContainText(`${name} · ${name === "admin" ? "관리자" : "멤버"}`);
  await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
  await expect(page.locator(".columns")).toBeVisible();
  await expect(page.locator(".login")).toHaveCount(0);
}
// Hold a specific network response until the test releases it; never sleep.
export async function hold(page, pattern, { actual = false } = {}) {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  await page.route(pattern, async route => {
    calls++;
    const response = actual ? await route.fetch() : undefined;
    entered();
    await gate;
    try {
      if (response) await route.fulfill({ response });
      else await route.continue();
    } catch { /* the timeout may have cancelled the request */ }
  });
  return { seen, release, count: () => calls };
}
