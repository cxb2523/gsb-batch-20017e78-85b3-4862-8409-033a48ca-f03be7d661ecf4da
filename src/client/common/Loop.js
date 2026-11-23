export default class Loop {
    constructor(callback, interval = null) {
        this.callback = callback;
        this.interval = interval;
        this.frame = null;
        this.update = this.update.bind(this);
    }

    get active() { return this.frame !== null; }

    setCallback(callback) {
        this.callback = callback;
    }

    start() {
        if (this.active) {
            return;
        }

        this.requestFrame();
    }

    stop() {
        if (!this.active) {
            return;
        }

        this.cancelFrame();
    }

    cancelFrame() {
        if (this.interval !== null) {
            clearTimeout(this.frame);
        } else {
            window.cancelAnimationFrame(this.frame);
        }

        this.frame = null;
    }

    requestFrame() {
        if (this.interval !== null) {
            this.frame = setTimeout(this.update, this.interval);
        } else {
            this.frame = window.requestAnimationFrame(this.update);
        }
    }

    update() {
        this.requestFrame();
        this.callback();
    }
}
