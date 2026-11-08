import { test, expect } from "@playwright/test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiLogin, loggedIn, date } from "./helpers/login.js";

for (const mode of ["새로고침", "기존 화면 요청"]) {
  test(`[TC-L-26] 실제 서버 프로세스 재시작 후 ${mode}`, async ({ page }) => {
    test.setTimeout(45000);
    const dir = await mkdtemp(join(tmpdir(), "booking-restart-"));
    let child;
    async function start(port = 0) {
      child = fork(new URL("./helpers/restart-server.js", import.meta.url), [], {
        env: { ...process.env, DB_PATH: join(dir, "db.sqlite"), PORT: String(port) },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const proc = child;
      return new Promise((resolve, reject) => {
        let errors = "";
        proc.stderr.on("data", b => { errors += b; });
        proc.once("error", reject);
        proc.once("exit", code => reject(new Error(`server exited ${code}: ${errors}`)));
        proc.once("message", value => resolve(value.port));
      });
    }
    async function stop() {
      if (!child || child.exitCode !== null) return;
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
    try {
      const port = await start(); const url = `http://127.0.0.1:${port}`;
      await page.goto(url); await uiLogin(page); await loggedIn(page);
      const cookies = await page.context().cookies();
      expect(cookies.some(c => c.name === "session")).toBe(true);
      await stop(); await start(port);
      expect((await page.request.get(url + "/api/health")).status()).toBe(200);
      expect((await page.request.get(url + "/api/me")).status()).toBe(401);
      if (mode === "새로고침") await page.reload();
      else {
        await page.getByLabel("예약 날짜").fill(date(28));
        await expect(page.locator(".notice")).toHaveText("로그인이 필요합니다. 다시 로그인해 주세요.");
      }
      await uiLogin(page); await loggedIn(page);
      await page.request.post(url + "/api/logout");
    } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
  });
}
