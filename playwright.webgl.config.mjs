import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/webgl',
  fullyParallel: false,
  workers: 1,
  // Headless SwiftShader (software GL) is substantially slower than hardware
  // rendering; give the metrics/readback-heavy tests generous headroom.
  timeout: 240000,
  expect: { timeout: 20000 },
  // Force process exit after results are reported: software-GL context
  // release can otherwise keep the runner alive during browser shutdown.
  globalTeardown: './tests/webgl/global-teardown.mjs',
  use: {
    baseURL: 'http://127.0.0.1:4180',
    // Use Playwright's bundled Chromium by default; PLAYWRIGHT_CHANNEL=chrome
    // opts into a system Chrome when the profile policy allows it.
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    acceptDownloads: true,
    // Software-GL (SwiftShader) contexts are slow to release; bound the
    // browser/context teardown so a stuck shutdown cannot hang the whole run.
    actionTimeout: 15000,
    navigationTimeout: 20000,
    // WebGL in headless Chromium uses SwiftShader; allow it explicitly.
    launchOptions: {
      args: [
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4180 --strictPort',
    url: 'http://127.0.0.1:4180/',
    reuseExistingServer: false,
    timeout: 60000,
  },
})
