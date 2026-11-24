// Under headless SwiftShader the browser process can linger during shutdown
// after all tests have completed and results have been flushed. Schedule a
// hard exit shortly after teardown so a slow software-GL context release cannot
// hang CI indefinitely, while still allowing normal stdout/report flushing.
export default async function globalTeardown() {
  setTimeout(() => process.exit(process.exitCode ?? 0), 5000).unref()
}
