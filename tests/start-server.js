import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "mini-booking-test-"));
process.env.DB_PATH = join(dir, "test.sqlite");
process.env.PORT = "3100";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
await import("../server/index.js");
