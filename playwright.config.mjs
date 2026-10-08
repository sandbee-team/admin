import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/ui",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 7000 },
  use: {
    baseURL: "http://127.0.0.1:8108",
    browserName: "chromium",
    channel: "msedge",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
  },
  webServer: {
    command: "node test/ui-server.js",
    url: "http://127.0.0.1:8108/ready",
    reuseExistingServer: false,
    timeout: 60000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
