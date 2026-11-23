/**
 * Offline test entry point: runs every exported test function across the three
 * suites and reports a non-zero exit code on any failure.
 */
import * as nodeTests from './node-stop.test'
import * as timedTests from './timed-strategy.test'
import * as workerTests from './worker-strategy.test'

type TestFn = () => Promise<void>

// Surface async errors that escape an individual test instead of aborting the
// whole process with no output.
process.on('unhandledRejection', (reason) => {
  console.log('UNHANDLED REJECTION:', reason instanceof Error ? reason.stack ?? reason.message : reason)
  process.exitCode = 1
})
process.on('uncaughtException', (error) => {
  console.log('UNCAUGHT EXCEPTION:', error.stack ?? error.message)
  process.exitCode = 1
})

function collect(module: Record<string, unknown>, prefix: string): Array<[string, TestFn]> {
  const tests: Array<[string, TestFn]> = []
  for (const [name, value] of Object.entries(module)) {
    if (name.startsWith('test') && typeof value === 'function') {
      tests.push([`${prefix} > ${name}`, value as TestFn])
    }
  }
  return tests
}

async function main(): Promise<void> {
  const allTests = [
    ...collect(nodeTests, 'node-stop'),
    ...collect(timedTests, 'timed-strategy'),
    ...collect(workerTests, 'worker-strategy'),
  ]

  let passed = 0
  const failures: Array<[string, unknown]> = []
  for (const [name, fn] of allTests) {
    try {
      await fn()
      passed++
      console.log(`PASS  ${name}`)
    }
    catch (error) {
      failures.push([name, error])
      console.log(`FAIL  ${name}`)
    }
  }

  console.log('')
  for (const [name, error] of failures) {
    console.log(`--- FAILURE: ${name}`)
    console.log(error instanceof Error ? error.stack ?? error.message : String(error))
    console.log('')
  }

  console.log(`${passed}/${allTests.length} tests passed`)
  if (failures.length > 0) {
    process.exitCode = 1
  }
}

void main()
