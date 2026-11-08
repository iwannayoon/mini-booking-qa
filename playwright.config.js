import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/start-server.js",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
  },
  projects: [
    { name: "api", testMatch: "**/*.api.spec.js" },
    {
      name: "chromium",
      testMatch: "**/*.e2e.spec.js",
      use: { browserName: "chromium" },
    },
  ],
});
