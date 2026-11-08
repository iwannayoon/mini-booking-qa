import { expect } from "@playwright/test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiLogin } from "./login.js";

// KST 시계를 고정한 전용 서버를 띄웁니다. setNow()는 이 서버의 시간만 이동합니다.
export async function startClockServer(now) {
  const dir = await mkdtemp(join(tmpdir(), "booking-clock-"));
  const child = fork(new URL("./clock-server.js", import.meta.url), [], {
    env: { ...process.env, DB_PATH: join(dir, "db.sqlite"), NOW: String(Date.parse(now)) },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const port = await new Promise((resolve, reject) => {
    let errors = "";
    child.stderr.on("data", b => { errors += b; });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`clock server exited ${code}: ${errors}`)));
    child.once("message", value => resolve(value.port));
  });
  return {
    baseURL: `http://127.0.0.1:${port}`,
    async setNow(value) {
      const reply = once(child, "message");
      child.send({ now: Date.parse(value) });
      await reply;
    },
    async stop() {
      if (child.exitCode === null) {
        const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function client(playwright, baseURL, name = "alice") {
  const context = await playwright.request.newContext({ baseURL });
  await apiLogin(context, name);
  return context;
}

export async function create(client, data) {
  const res = await client.post("/api/bookings", { data });
  expect(res.status()).toBe(201);
  return res.json();
}

export const rows = async (client) => (await client.get("/api/bookings")).json();

export async function slotState(client, value) {
  const res = await client.get(`/api/slots?date=${value.slice(0, 10)}`);
  expect(res.status()).toBe(200);
  return (await res.json()).find(s => s.slot === value);
}

// 정리용: 해당 사용자가 지정 슬롯에 가진 확정 예약을 모두 취소합니다.
export async function cancelSlots(client, slots) {
  for (const row of await rows(client))
    if (row.status === "confirmed" && slots.includes(row.slot))
      await client.post(`/api/bookings/${row.id}/cancel`);
}
