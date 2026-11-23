// ==============================================
// 极简本地测试框架：用例通过 test() 注册，runTests() 统一执行并汇总。
// 不依赖 node:test 的进程模型，避免自定义 ESM loader 下嵌套结果被折叠。
// ==============================================
type TestFn = () => void | Promise<void>;
interface Case {
    name: string;
    fn: TestFn;
}

const cases: Case[] = [];

export function test(name: string, fn: TestFn): void {
    cases.push({ name, fn });
}

export async function runTests(): Promise<void> {
    let pass = 0;
    let fail = 0;
    const failures: string[] = [];

    for (const c of cases) {
        try {
            await c.fn();
            pass++;
            console.log(`  ✔ ${c.name}`);
        } catch (err: any) {
            fail++;
            failures.push(c.name);
            console.log(`  ✖ ${c.name}`);
            const msg = err?.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : String(err);
            console.log(msg.split('\n').map(l => `      ${l}`).join('\n'));
        }
    }

    console.log('\n----------------------------------------');
    console.log(`通过 ${pass} 项，失败 ${fail} 项`);
    if (fail) {
        console.log('失败用例:');
        failures.forEach(f => console.log(`  - ${f}`));
        process.exitCode = 1;
    }
}
