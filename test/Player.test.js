jest.mock('@client/container', () => ({ get: jest.fn(() => ({ mock: 'api' })) }));
jest.mock('@client/common/Showtime', () => jest.fn().mockImplementation(() => ({
    onPlayed: jest.fn(),
    onPaused: jest.fn(),
    onUIEnter: jest.fn(),
    onUILeave: jest.fn(),
})));
jest.mock('@client/components/Controls', () => () => null);
jest.mock('@client/components/Timeline', () => () => null);
jest.mock('@client/components/AuthorizationModal', () => () => null);
jest.mock('@client/components/video', () => ({
    Video: function VideoMock() {},
    YoutubeVideo: function YoutubeVideoMock() {},
}));

import { Component } from 'react';
import ConnectedPlayer from '@client/components/Player';

// Unwrap the react-redux connected component to test the raw class without
// rendering any player markup.
const Player = ConnectedPlayer.WrappedComponent || ConnectedPlayer;

function mountPlayer(overrides = {}) {
    const props = {
        source: 'file',
        url: 'blob:one',
        setShowtime: jest.fn(),
        ...overrides,
    };

    const player = new Player(props);
    const timeline = { reset: jest.fn() };

    player.timeline = timeline;
    player.video = { currentTime: 0, duration: 0, buffered: { length: 0 } };

    const update = nextProps => {
        const prevProps = player.props;
        player.props = nextProps;
        player.componentDidUpdate(prevProps);
    };

    return { player, timeline, props, update };
}

describe('Player: source change resets the timeline', () => {
    test('is a React component exposing the ref setters used by the markup', () => {
        const { player } = mountPlayer();

        expect(player).toBeInstanceOf(Component);
        expect(typeof player.setVideo).toBe('function');
        expect(typeof player.setTimeline).toBe('function');
    });

    test('a new video url resets timeline progress and buffered parts immediately', () => {
        const { timeline, update } = mountPlayer();

        update({ source: 'file', url: 'blob:two', setShowtime: jest.fn() });

        expect(timeline.reset).toHaveBeenCalledTimes(1);
    });

    test('does not reset the timeline when unrelated props change', () => {
        const { timeline, update } = mountPlayer();

        update({ source: 'file', url: 'blob:one', setShowtime: jest.fn() });

        expect(timeline.reset).not.toHaveBeenCalled();
    });

    test('survives a source change before the timeline ref is attached', () => {
        const { player } = mountPlayer();

        player.timeline = null;

        expect(() => {
            player.componentDidUpdate(player.props);
            player.componentDidUpdate({ source: 'url', url: 'https://example.test/x.mp4', setShowtime: jest.fn() });
        }).not.toThrow();
    });
});
