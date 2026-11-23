import reducer, {
    loadVideoFromFile,
    loadVideoFromUrl,
    loadVideoFromYoutube,
    loadVideoFromServer,
    setDuration,
    setLoaded,
    setAuthorized,
    play,
    seek,
} from '@client/store/player';

const initialState = reducer(undefined, { type: '@@INIT' });

// Build a state representing a video that was playing, fully loaded and
// authorized, with a known duration and progress.
function playingState() {
    let state = reducer(initialState, loadVideoFromFile('blob:old', 'old.mp4', 'video/mp4'));
    state = reducer(state, setDuration(420));
    state = reducer(state, setLoaded(true));
    state = reducer(state, setAuthorized(true));
    state = reducer(state, play(123.4));

    return state;
}

describe('player reducer: source switching resets the whole playback state', () => {
    test.each([
        [ 'file', () => loadVideoFromFile('blob:next', 'next.mp4', 'video/mp4') ],
        [ 'url', () => loadVideoFromUrl('https://example.test/next.mp4', '/next.mp4', 'video/mp4') ],
        [ 'youtube', () => loadVideoFromYoutube('abc123') ],
        [ 'server', () => loadVideoFromServer('url', 'remote.mp4', 'https://example.test/remote.mp4') ],
    ])('PLAYER_LOAD_FROM_%s clears duration, loaded, authorized, buffer and progress', (_label, actionFactory) => {
        const state = reducer(playingState(), actionFactory());

        expect(state.duration).toBeNull();
        expect(state.loaded).toBe(false);
        expect(state.authorized).toBe(true);
        expect(state.playing).toBe(false);
        expect(state.time).toBe(0);
        expect(state.sources).toEqual([]);
    });

    test('switching from a file to another file zeroes the timeline and points at the new source', () => {
        const state = reducer(playingState(), loadVideoFromFile('blob:next', 'next.mkv', 'video/x-matroska'));

        expect(state.url).toBe('blob:next');
        expect(state.name).toBe('next.mkv');
        expect(state.source).toBe('file');
        expect(state.time).toBe(0);
        expect(state.playing).toBe(false);
        expect(state.duration).toBeNull();
        expect(state.loaded).toBe(false);
    });

    test('switching to a youtube source keeps the video id and drops every previous playback value', () => {
        const state = reducer(playingState(), loadVideoFromYoutube('BathEBfiG1s'));

        expect(state.url).toBe('BathEBfiG1s');
        expect(state.source).toBe('youtube');
        expect(state.time).toBe(0);
        expect(state.duration).toBeNull();
        expect(state.loaded).toBe(false);
        expect(state.playing).toBe(false);
    });

    test('a server pushed video is reset exactly like a locally loaded one', () => {
        const state = reducer(playingState(), loadVideoFromServer('youtube', 'clip', 'zyx987'));

        expect(state.fromServer).toBe(true);
        expect(state.url).toBe('zyx987');
        expect(state.duration).toBeNull();
        expect(state.loaded).toBe(false);
        expect(state.playing).toBe(false);
        expect(state.time).toBe(0);
        expect(state.sources).toEqual([]);
    });

    test('several successive switches always start from a clean, unloaded state', () => {
        let state = playingState();

        state = reducer(state, loadVideoFromUrl('https://example.test/a.mp4', '/a.mp4', 'video/mp4'));
        expect(state.time).toBe(0);
        expect(state.loaded).toBe(false);

        state = reducer(state, setDuration(60));
        state = reducer(state, setLoaded(true));
        state = reducer(state, seek(55));

        state = reducer(state, loadVideoFromYoutube('video-two'));
        expect(state.duration).toBeNull();
        expect(state.loaded).toBe(false);
        expect(state.time).toBe(0);
        expect(state.sources).toEqual([]);

        state = reducer(state, loadVideoFromFile('blob:three', 'three.mp4', 'video/mp4'));
        expect(state.duration).toBeNull();
        expect(state.loaded).toBe(false);
        expect(state.time).toBe(0);
        expect(state.playing).toBe(false);
        expect(state.authorized).toBe(true);
    });

    test('loaded and authorized flags are restored to their initial defaults on switch', () => {
        let state = playingState();
        state = reducer(state, setAuthorized(false));
        state = reducer(state, loadVideoFromYoutube('new-id'));

        expect(state.authorized).toBe(true);
        expect(state.loaded).toBe(false);
    });
});
