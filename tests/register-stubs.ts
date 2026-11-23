// ==============================================
// 本地验证用 ESM 加载器：为单元测试打桩 three 等重型依赖与浏览器全局，
// 无需 npm install 即可让被测的纯逻辑模块在 Node 下运行。
// 用法: node --experimental-transform-types --import ./tests/register-stubs.ts ...
// ==============================================
import { register } from 'node:module';

// ---- 浏览器全局打桩（仓库模块在顶层引用了 DOM API） ----
if (typeof (globalThis as any).location === 'undefined') {
    (globalThis as any).location = { hostname: 'localhost', href: 'http://localhost/', protocol: 'http:' };
}
if (typeof (globalThis as any).window === 'undefined') {
    (globalThis as any).window = globalThis;
}
if (typeof (globalThis as any).document === 'undefined') {
    (globalThis as any).document = {
        createElement: () => ({ style: {}, appendChild() {}, removeChild() {}, click() {} }),
        getElementById: () => null,
        querySelector: () => null,
        head: { appendChild() {} },
        body: { appendChild() {}, removeChild() {} },
        createTextNode: (t: string) => ({ nodeValue: t }),
    };
}
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
    (globalThis as any).requestAnimationFrame = (fn: Function) => setTimeout(() => fn(Date.now()), 16);
    (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
}
if (typeof (globalThis as any).performance === 'undefined') {
    (globalThis as any).performance = { now: () => Date.now() };
}
if (typeof (globalThis as any).navigator === 'undefined') {
    (globalThis as any).navigator = { userAgent: 'node-test' };
}
if (typeof (globalThis as any).URL?.createObjectURL === 'undefined') {
    (globalThis as any).URL.createObjectURL = () => 'blob:mock';
    (globalThis as any).URL.revokeObjectURL = () => {};
}
if (typeof (globalThis as any).Worker === 'undefined') {
    (globalThis as any).Worker = class {
        postMessage() {}
        terminate() {}
        set onmessage(_: any) {}
    };
}
if (typeof (globalThis as any).AudioContext === 'undefined') {
    (globalThis as any).AudioContext = class {};
    (globalThis as any).webkitAudioContext = (globalThis as any).AudioContext;
}
if (typeof (globalThis as any).HTMLCanvasElement === 'undefined') {
    (globalThis as any).HTMLCanvasElement = class {};
}

register(new URL('./stub-loader.ts', import.meta.url));
