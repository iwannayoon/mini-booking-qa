// Isolated child process used only by the server-restart integration test.
import { createServer } from "vite";
import { createApp } from "../../server/app.js";
import { openDb } from "../../server/db.js";
const db = openDb(process.env.DB_PATH);
const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "spa" });
const app = createApp(db);
app.use(vite.middlewares);
const server = app.listen(Number(process.env.PORT || 0), "127.0.0.1", () => {
  process.send({ port: server.address().port });
});
process.on("SIGTERM", async () => {
  server.closeAllConnections();
  server.close(async () => { await vite.close(); db.close(); process.exit(0); });
});
