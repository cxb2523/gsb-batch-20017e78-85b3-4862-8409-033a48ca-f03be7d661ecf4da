import Timeline from '@client/components/Timeline';

describe('Timeline reset on source switch', () => {
    test('reset clears played progress, buffered parts and displayed times', () => {
        const timeline = new Timeline({ onSeek: jest.fn() });

        timeline.setState({
            time: '2:03',
            duration: '7:00',
            loaded: [ [ 10, 40 ], [ 60, 80 ] ],
            played: 29.286,
        });

        const setStateSpy = jest.spyOn(timeline, 'setState');
        timeline.reset();

        expect(setStateSpy).toHaveBeenCalledWith({
            time: '',
            duration: '',
            loaded: [],
            played: 0,
        });
    });
});
