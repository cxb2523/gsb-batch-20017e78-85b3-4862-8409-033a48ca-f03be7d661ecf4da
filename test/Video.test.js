import Video from '@client/components/video/Video';

function createElement() {
    return {
        currentTime: 0,
        duration: 0,
        volume: 0,
        buffered: { length: 0, start: jest.fn(), end: jest.fn() },
        play: jest.fn(() => Promise.resolve()),
        pause: jest.fn(),
        stop: jest.fn(),
    };
}

function createProps(overrides = {}) {
    return {
        src: 'blob:one',
        playing: false,
        time: 0,
        authorized: true,
        loaded: false,
        volume: 0.5,
        preload: 'auto',
        setDuration: jest.fn(),
        setLoaded: jest.fn(),
        setAuthorized: jest.fn(),
        end: jest.fn(),
        onTimeUpdate: jest.fn(),
        onDurationChange: jest.fn(),
        onProgress: jest.fn(),
        onPlayed: jest.fn(),
        onPaused: jest.fn(),
        onEnded: jest.fn(),
        ...overrides,
    };
}

function mountVideo(props = createProps()) {
    const video = new Video(props);
    const element = createElement();

    video.element = element;

    // Simulate React feeding new props to the instance.
    const update = nextProps => {
        const prevProps = video.props;
        video.props = nextProps;
        video.componentDidUpdate(prevProps);
    };

    return { video, element, props, update };
}

// Build the next props from the current object, keeping nested mock functions
// (e.g. setLoaded) identical so call history stays observable.
function nextProps(current, overrides) {
    return { ...current, ...overrides };
}

describe('Video component: source switching state transition', () => {
    test('ignores play, pause and seek requests while the new source is not ready', () => {
        const { video, element } = mountVideo();

        expect(video.ready).toBe(false);

        video.play(42);
        video.pause(42);
        video.seek(42);

        expect(element.play).not.toHaveBeenCalled();
        expect(element.pause).not.toHaveBeenCalled();
        expect(element.currentTime).toBe(0);
    });

    test('becomes ready on canplay and applies the playing room state broadcast during loading', () => {
        const props = createProps({ playing: true, time: 30, loaded: false });
        const { video, element } = mountVideo(props);

        video.onCanPlay();

        expect(video.ready).toBe(true);
        expect(props.setLoaded).toHaveBeenCalledWith(true);
        expect(element.currentTime).toBe(30);
        expect(element.play).toHaveBeenCalledTimes(1);
    });

    test('paused room state on canplay pauses and seeks instead of playing', () => {
        const props = createProps({ playing: false, time: 15 });
        const { video, element } = mountVideo(props);

        video.onCanPlay();

        expect(video.ready).toBe(true);
        expect(element.pause).toHaveBeenCalledTimes(1);
        expect(element.currentTime).toBe(15);
        expect(element.play).not.toHaveBeenCalled();
    });

    test('changing src resets the internal ready flag and goes back to the unloaded state', () => {
        const props = createProps({ loaded: true });
        const { video, element, update } = mountVideo(props);

        video.onCanPlay();
        element.currentTime = 99;
        props.setLoaded.mockClear();

        update(nextProps(props, { src: 'blob:two', loaded: true }));

        expect(video.ready).toBe(false);
        expect(props.setLoaded).toHaveBeenCalledWith(false);

        // Controls arriving after the switch must not touch the stale element.
        video.play(120);
        video.seek(120);
        expect(element.currentTime).toBe(99);
        expect(element.play).not.toHaveBeenCalled();
    });    test('room play/pause/seek only drive the element after the new source is ready', () => {
        const props = createProps({ loaded: true });
        const { video, element, update } = mountVideo(props);

        video.onCanPlay();

        update(createProps({ loaded: true, playing: true, time: 25 }));
        expect(element.play).toHaveBeenCalledTimes(1);
        expect(element.currentTime).toBe(25);

        element.pause.mockClear();
        update(createProps({ loaded: true, playing: false, time: 10 }));
        expect(element.pause).toHaveBeenCalledTimes(1);
        expect(element.currentTime).toBe(10);

        update(createProps({ loaded: true, playing: false, time: 33 }));
        expect(element.currentTime).toBe(33);
    });

    test('loadstart of a new source clears readiness even before React processes the prop change', () => {
        const props = createProps({ loaded: true });
        const { video } = mountVideo(props);

        video.onCanPlay();
        expect(video.ready).toBe(true);

        video.onLoadStart();

        expect(video.ready).toBe(false);
        expect(props.setLoaded).toHaveBeenCalledWith(false);
    });

    test('a seek received while loading is applied once canplay fires, not before', () => {
        const props = createProps({ time: 75 });
        const { video, element, update } = mountVideo(props);

        update(createProps({ time: 75 }));
        expect(element.currentTime).toBe(0);

        video.onCanPlay();
        expect(element.currentTime).toBe(75);
    });

    test('volume changes still apply while the source is loading', () => {
        const { video, element, update } = mountVideo();

        update(createProps({ volume: 0.8 }));

        expect(element.volume).toBe(0.8);
        expect(video.ready).toBe(false);
    });
});
