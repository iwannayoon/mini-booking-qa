// 서버 시간 경계 테스트 전용 API 서버입니다. 테스트가 IPC로 Date.now()를 제어합니다.
// 운영 코드는 수정하지 않으며, 고정된 시계는 이 자식 프로세스에만 적용됩니다.
import { createApp } from "../../server/app.js";
import { openDb } from "../../server/db.js";
let now = Number(process.env.NOW);
Date.now = () => now;
process.on("message", (message) => {
  now = message.now;
  process.send({ now });
});
const db = openDb(process.env.DB_PATH);
const server = createApp(db).listen(0, "127.0.0.1", () => {
  process.send({ port: server.address().port });
});
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => { db.close(); process.exit(0); });
});
