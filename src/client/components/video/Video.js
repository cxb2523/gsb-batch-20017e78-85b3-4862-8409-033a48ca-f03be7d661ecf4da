import { Component } from 'react';
import PropTypes from 'prop-types';
import Subtitles from '@client/components/Subtitles';

export default class Video extends Component {
    static propTypes = {
        src: PropTypes.string.isRequired,
        playing: PropTypes.bool.isRequired,
        time: PropTypes.number.isRequired,
        authorized: PropTypes.bool.isRequired,
        loaded: PropTypes.bool.isRequired,
        setDuration: PropTypes.func.isRequired,
        setLoaded: PropTypes.func.isRequired,
        setAuthorized: PropTypes.func.isRequired,
        end: PropTypes.func.isRequired,
        onTimeUpdate: PropTypes.func.isRequired,
        onDurationChange: PropTypes.func.isRequired,
        onProgress: PropTypes.func.isRequired,
        onPlayed: PropTypes.func.isRequired,
        onPaused: PropTypes.func.isRequired,
        onEnded: PropTypes.func.isRequired,
        preload: PropTypes.string,
        volume: PropTypes.number.isRequired,
    };

    static defaultProps = {
        preload: 'auto',
    };

    constructor(props) {
        super(props);

        this.element = null;
        this.ready = false;

        this.setElement = this.setElement.bind(this);
        this.play = this.play.bind(this);
        this.onLoadStart = this.onLoadStart.bind(this);
        this.onCanPlay = this.onCanPlay.bind(this);
        this.onCanPlayThrough = this.onCanPlayThrough.bind(this);
        this.onDurationChange = this.onDurationChange.bind(this);
        this.onNotAuthorized = this.onNotAuthorized.bind(this);
        this.onEnded = this.onEnded.bind(this);
        this.onAuthorized = this.onAuthorized.bind(this);
        this.onError = this.onError.bind(this);
    }


    get currentTime() { return parseFloat(this.element.currentTime.toFixed(3), 10); }
    get duration() { return parseFloat(this.element.duration.toFixed(3), 10); }
    get buffered() { return this.element.buffered; }

    componentDidUpdate(prevProps) {
        const { src, time, playing, volume } = this.props;

        if (volume !== prevProps.volume) {
            this.element.volume = this.props.volume;
        }

        // A new source means the previous element state (time, buffer,
        // readiness) is stale: go back to the unloaded state and ignore
        // every room control until the new source can play.
        if (src !== prevProps.src) {
            this.resetOnSourceChange(prevProps);

            return;
        }

        if (!this.ready) {
            return;
        }

        if (playing !== prevProps.playing) {
            playing ? this.play(time) : this.pause(time);
        } else if (time !== prevProps.time) {
            this.seek(time);
        }
    }

    resetOnSourceChange(prevProps = this.props) {
        this.ready = false;

        if (prevProps.loaded) {
            this.props.setLoaded(false);
        }
    }

    // Once the new source is playable, catch up with the room state that
    // was broadcast while the video was still loading.
    reconcile() {
        const { playing, time } = this.props;

        if (playing) {
            this.play(time);
        } else {
            this.pause(time);
        }
    }

    setElement(element) {
        this.element = element;

        if (element) {
            this.element.volume = this.props.volume;
        }
    }

    play(time) {
        if (!this.ready) {
            return;
        }

        this.seek(time);

        let promise = null;

        try {
            promise = this.element.play();
        } catch (error) {
            this.onNotAuthorized(error);
        }

        if (promise) {
            promise.then(this.onAuthorized).catch(this.onNotAuthorized);
        } else {
            this.onAuthorized();
        }
    }

    pause(time) {
        if (!this.ready) {
            return;
        }

        this.element.pause();
        this.seek(time);
    }

    stop() {
        this.element.stop();
    }

    seek(time) {
        if (this.ready && typeof time === 'number') {
            this.element.currentTime = time;
        }
    }

    onAuthorized() {
        if (!this.props.authorized) {
            this.props.setAuthorized(true);
        }
    }

    onNotAuthorized(error) {
        if (error instanceof DOMException && error.name === 'NotAllowedError' && this.props.authorized) {
            this.props.setAuthorized(false);
        }
    }

    onLoadStart() {
        this.ready = false;

        if (this.props.loaded) {
            this.props.setLoaded(false);
        }
    }

    onCanPlay() {
        this.ready = true;

        if (!this.props.loaded) {
            this.props.setLoaded(true);
        }

        this.reconcile();
    }

    onCanPlayThrough() {

    }

    onDurationChange() {
        this.props.setDuration(this.element.duration);
        this.props.onDurationChange();
    }

    onEnded() {
        this.props.end();
        this.props.onEnded();
    }

    onError(error) {
        console.error(error);
    }

    render(){
        const { src, preload } = this.props;

        return (
            <video
                ref={this.setElement}
                src={src}
                preload={preload}
                onLoadStart={this.onLoadStart}
                onProgress={this.props.onProgress}
                onCanPlay={this.onCanPlay}
                onCanPlayThrough={this.onCanPlayThrough}
                onDurationChange={this.onDurationChange}
                onTimeUpdate={this.props.onTimeUpdate}
                onPlay={this.props.onPlayed}
                onPause={this.props.onPaused}
                onEnded={this.onEnded}
            >
                <Subtitles />
            </video>
        );
    }
}
