import reducer, {
    loadVideoFromFile,
    loadVideoFromUrl,
    loadVideoFromYoutube,
    loadVideoFromServer,
    setDuration,
    setLoaded,
    play,
    pause,
    seek,
} from '@client/store/player';
import Video from '@client/components/video/Video';

// End-to-end style transition: the Redux store drives the local Video
// component through several source switches, mirroring what room members
// receive when the owner changes the video.
describe('source switching state migration (store + Video component)', () => {
    function mockElement() {
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

    function componentPropsFrom(state, overrides = {}) {
        return {
            src: state.url,
            playing: state.playing,
            time: state.time,
            authorized: state.authorized,
            loaded: state.loaded,
            volume: 0.5,
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

    test('each switch zeroes the timeline, drops the buffer state and blocks controls until canplay', () => {
        let state = reducer(undefined, { type: '@@INIT' });

        // First source: a local file that loads and plays.
        state = reducer(state, loadVideoFromFile('blob:one', 'one.mp4', 'video/mp4'));
        expect(state.time).toBe(0);
        expect(state.loaded).toBe(false);

        let component = new Video(componentPropsFrom(state));
        let element = mockElement();
        component.element = element;
        component.onCanPlay();
        state = reducer(state, setLoaded(true));
        state = reducer(state, setDuration(100));
        state = reducer(state, play(40));

        // Second source: remote URL arriving from the room while source one is playing.
        state = reducer(state, loadVideoFromServer('url', 'two.mp4', 'https://example.test/two.mp4'));
        expect(state.time).toBe(0);
        expect(state.playing).toBe(false);
        expect(state.duration).toBeNull();
        expect(state.loaded).toBe(false);
        expect(state.sources).toEqual([]);

        // A room play broadcast for the not-yet-loaded source must be ignored.
        const pendingState = reducer(state, play(60));
        component = new Video(componentPropsFrom(pendingState));
        element = mockElement();
        component.element = element;
        expect(component.ready).toBe(false);
        component.play(pendingState.time);
        component.seek(pendingState.time);
        expect(element.play).not.toHaveBeenCalled();
        expect(element.currentTime).toBe(0);

        // Once the new source can play, it catches up with the room position.
        component.onCanPlay();
        expect(element.currentTime).toBe(60);
        expect(element.play).toHaveBeenCalledTimes(1);

        // Third source: YouTube id, again starting from a clean slate.
        state = reducer(pendingState, loadVideoFromYoutube('yt-three'));
        expect(state.url).toBe('yt-three');
        expect(state.source).toBe('youtube');
        expect(state.time).toBe(0);
        expect(state.duration).toBeNull();
        expect(state.loaded).toBe(false);

        // Fourth source: another local file.
        state = reducer(state, loadVideoFromFile('blob:four', 'four.mkv', 'video/x-matroska'));
        expect(state.time).toBe(0);
        expect(state.playing).toBe(false);
        expect(state.authorized).toBe(true);
        expect(state.sources).toEqual([]);

        // Pause/seek room controls only take effect after loading completes.
        const pausedState = reducer(state, pause(0));
        component = new Video(componentPropsFrom(pausedState));
        element = mockElement();
        component.element = element;
        component.seek(25);
        expect(element.currentTime).toBe(0);
        component.onCanPlay();
        expect(element.pause).toHaveBeenCalled();
        expect(element.currentTime).toBe(0);

        // A later seek after readiness reaches the element.
        const seekState = reducer(pausedState, seek(25));
        component.props = componentPropsFrom(seekState);
        component.componentDidUpdate(componentPropsFrom(pausedState));
        expect(element.currentTime).toBe(25);
    });
});
