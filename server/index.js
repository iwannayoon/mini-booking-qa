import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { createServer } from "vite";
const db = openDb(process.env.DB_PATH || "data/booking.sqlite");
const app = createApp(db);
const vite = await createServer({
  server: { middlewareMode: true },
  appType: "spa",
});
app.use(vite.middlewares);
const server = app.listen(Number(process.env.PORT || 3000), "127.0.0.1", () =>
  console.log(`Mini Booking: http://127.0.0.1:${process.env.PORT || 3000}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(async () => {
      await vite.close();
      db.close();
      process.exit(0);
    }),
  );
