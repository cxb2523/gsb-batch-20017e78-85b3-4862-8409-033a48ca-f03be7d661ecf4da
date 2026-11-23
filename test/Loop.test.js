import Loop from '@client/common/Loop';

describe('Loop', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        window.requestAnimationFrame = jest.fn(cb => setTimeout(() => cb(Date.now()), 0));
        window.cancelAnimationFrame = jest.fn(id => clearTimeout(id));
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('interval mode schedules repeated callbacks and stops cleanly', () => {
        const callback = jest.fn();
        const loop = new Loop(callback, 500);

        loop.start();
        expect(loop.active).toBe(true);

        jest.advanceTimersByTime(1200);
        expect(callback.mock.calls.length).toBeGreaterThanOrEqual(2);

        loop.stop();
        const calls = callback.mock.calls.length;
        jest.advanceTimersByTime(2000);
        expect(callback.mock.calls.length).toBe(calls);
        expect(loop.active).toBe(false);
    });

    test('start and stop are idempotent', () => {
        const loop = new Loop(jest.fn(), 100);

        loop.start();
        loop.start();
        expect(loop.active).toBe(true);

        loop.stop();
        loop.stop();
        expect(loop.active).toBe(false);
    });

    test('stop before start never leaves a pending frame', () => {
        const loop = new Loop(jest.fn(), 100);

        loop.stop();
        jest.advanceTimersByTime(500);

        expect(loop.active).toBe(false);
    });
});
