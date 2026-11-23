jest.mock('@client/container', () => ({ get: jest.fn(() => ({ mock: 'api' })) }));

import YoutubeVideo from '@client/components/video/YoutubeVideo';

const PLAYER_STATES = {
    UNSTARTED: -1,
    ENDED: 0,
    PLAYING: 1,
    PAUSED: 2,
    BUFFERING: 3,
};

function createPlayerMock() {
    const player = {
        state: PLAYER_STATES.UNSTARTED,
        destroyed: false,
        getCurrentTime: jest.fn(() => 12.345),
        getDuration: jest.fn(() => 600),
        getVideoLoadedFraction: jest.fn(() => 0.42),
        getVideoData: jest.fn(() => ({ title: 'A video' })),
        seekTo: jest.fn(),
        setVolume: jest.fn(),
        setSize: jest.fn(),
    };

    player.getPlayerState = jest.fn(() => player.state);
    player.playVideo = jest.fn(() => { player.state = PLAYER_STATES.PLAYING; });
    player.pauseVideo = jest.fn(() => { player.state = PLAYER_STATES.PAUSED; });
    player.stopVideo = jest.fn(() => { player.state = PLAYER_STATES.UNSTARTED; });
    player.destroy = jest.fn(() => { player.destroyed = true; });

    return player;
}

function createProps(overrides = {}) {
    return {
        src: 'video-one',
        playing: false,
        time: 0,
        authorized: true,
        loaded: false,
        volume: 0.5,
        setDuration: jest.fn(),
        setLoaded: jest.fn(),
        setAuthorized: jest.fn(),
        setName: jest.fn(),
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

// Build the next props from the current object, keeping nested mock functions
// identical so call history stays observable across updates.
function nextProps(current, overrides) {
    return { ...current, ...overrides };
}

function mountYoutube(props = createProps()) {
    const player = createPlayerMock();
    let captured = null;

    global.YT = {
        PlayerState: PLAYER_STATES,
        Player: jest.fn((_id, config) => {
            captured = config;

            return player;
        }),
    };

    const video = new YoutubeVideo(props);

    video.element = { id: 'youtube-player' };
    video.componentDidMount();

    const events = captured.events;

    const update = nextProps => {
        const prevProps = video.props;
        video.props = nextProps;
        video.componentDidUpdate(prevProps);
    };

    return { video, player, events, props, update };
}

describe('YoutubeVideo component: source switching state transition', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        window.requestAnimationFrame = jest.fn(cb => setTimeout(() => cb(Date.now()), 0));
        window.cancelAnimationFrame = jest.fn(id => clearTimeout(id));
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('creates a YT player on mount and stays unloaded until onReady', () => {
        const { video, player, props } = mountYoutube();

        expect(global.YT.Player).toHaveBeenCalledTimes(1);
        expect(video.ready).toBe(false);
        expect(props.setLoaded).toHaveBeenCalledWith(false);
        expect(player.playVideo).not.toHaveBeenCalled();
    });

    test('ignores play, pause and seek requests before the player is ready', () => {
        const { video, player, update } = mountYoutube();

        video.play(42);
        video.pause(42);
        video.seek(42);
        update(createProps({ src: 'video-one', playing: true, time: 42 }));

        expect(player.playVideo).not.toHaveBeenCalled();
        expect(player.pauseVideo).not.toHaveBeenCalled();
        expect(player.seekTo).not.toHaveBeenCalled();
    });

    test('onReady marks the component loaded, starts the time polling loop and reconciles', () => {
        const props = createProps({ playing: true, time: 20 });
        const { video, player, events } = mountYoutube(props);

        events.onReady();

        expect(video.ready).toBe(true);
        expect(props.setLoaded).toHaveBeenLastCalledWith(true);
        expect(props.setName).toHaveBeenCalledWith('A video');
        expect(props.setDuration).toHaveBeenCalledWith(600);
        expect(player.seekTo).toHaveBeenCalledWith(20);
        expect(player.playVideo).toHaveBeenCalledTimes(1);
        expect(video.loop.active).toBe(true);

        jest.advanceTimersByTime(600);
        expect(props.onTimeUpdate).toHaveBeenCalled();
    });

    test('room controls are accepted only after readiness', () => {
        const { video, player, events, update } = mountYoutube();

        events.onReady();

        update(createProps({ src: 'video-one', playing: true, time: 55 }));
        expect(player.seekTo).toHaveBeenLastCalledWith(55);
        expect(player.playVideo).toHaveBeenCalledTimes(1);

        player.pauseVideo.mockClear();
        update(createProps({ src: 'video-one', playing: false, time: 11 }));
        // pause() pauses once, and seek() pauses again while not playing.
        expect(player.pauseVideo).toHaveBeenCalledTimes(2);
        expect(player.seekTo).toHaveBeenLastCalledWith(11);
    });

    test('changing src stops polling, clears readiness and re-enters the unloaded state', () => {
        const props = createProps({ loaded: true });
        const { video, player, events, update } = mountYoutube(props);

        events.onReady();
        expect(video.loop.active).toBe(true);
        props.setLoaded.mockClear();

        update(nextProps(props, { src: 'video-two', playing: true, time: 88 }));

        expect(video.ready).toBe(false);
        expect(video.loop.active).toBe(false);
        expect(props.setLoaded).toHaveBeenCalledWith(false);

        // Room controls for the new source must not reach the stale player.
        expect(player.playVideo).not.toHaveBeenCalled();
        expect(player.seekTo).not.toHaveBeenCalledWith(88);
    });

    test('after switching src, the next onReady reconciles with the new room state', () => {
        const props = createProps();
        const { video, player, events, update } = mountYoutube(props);

        events.onReady();
        update(nextProps(props, { src: 'video-two', playing: true, time: 77 }));
        expect(video.ready).toBe(false);

        events.onReady();

        expect(video.ready).toBe(true);
        expect(player.seekTo).toHaveBeenLastCalledWith(77);
        expect(player.playVideo).toHaveBeenCalled();
        expect(video.loop.active).toBe(true);
    });

    test('unmount stops the polling loop, cancels the authorization timer and destroys the player', () => {
        const { video, player, events } = mountYoutube();

        events.onReady();
        video.play(5);
        expect(video.authorizationTimeout).not.toBeNull();
        expect(video.loop.active).toBe(true);

        video.componentWillUnmount();

        expect(video.loop.active).toBe(false);
        expect(video.authorizationTimeout).toBeNull();
        expect(player.destroy).toHaveBeenCalledTimes(1);
        expect(video.player).toBeNull();

        // No polling callback may fire after destruction.
        const pollingCalls = video.props.onTimeUpdate.mock.calls.length;
        jest.advanceTimersByTime(3000);
        expect(video.props.onTimeUpdate.mock.calls.length).toBe(pollingCalls);
    });

    test('player callbacks after unmount do not touch the destroyed instance', () => {
        const { video, player, events, props } = mountYoutube();

        events.onReady();
        const readyBeforeUnmount = video.ready;
        video.componentWillUnmount();

        // A late onReady must not resurrect a destroyed player.
        events.onReady();
        expect(video.ready).toBe(readyBeforeUnmount);
        expect(video.loop.active).toBe(false);

        events.onStateChange({ data: PLAYER_STATES.PLAYING });
        video.checkAuthorization();
        video.onResize();

        expect(props.onPlayed).not.toHaveBeenCalled();
        expect(player.setSize).not.toHaveBeenCalled();
        expect(props.setAuthorized).not.toHaveBeenCalled();
    });

    test('authorization check scheduled by play is cleared on unmount', () => {
        const { video, events } = mountYoutube();

        events.onReady();
        video.play(5);
        expect(video.authorizationTimeout).not.toBeNull();

        video.componentWillUnmount();
        jest.advanceTimersByTime(2500);

        // The cancelled timer must never flip the authorization flag.
        expect(video.props.setAuthorized).not.toHaveBeenCalled();
    });
});
