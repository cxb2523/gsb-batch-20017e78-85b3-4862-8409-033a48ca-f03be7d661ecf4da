import { describe, it, expect, vi, beforeEach } from "vitest";
import Config from "@/config";
import {
    DELAY_ENABLED, DELAY_FEEDBACK, DELAY_DRY, DELAY_CUTOFF, DELAY_TIME, DELAY_OFFSET,
    EQ_ENABLED, EQ_LOW, EQ_MID, EQ_HIGH,
    FILTER_ENABLED, FILTER_FREQ, FILTER_Q, FILTER_LFO_ENABLED, FILTER_LFO_SPEED, FILTER_LFO_DEPTH,
    OD_ENABLED, OD_DRIVE, OD_PRE_BAND, OD_COLOR, OD_POST_CUT,
    PAN_LEFT, PAN_RIGHT, PITCH_UP,
    VOLUME
} from "@/definitions/automatable-parameters";
import type { EffluxAudioEvent } from "@/model/types/audio-event";
import EventFactory from "@/model/factories/event-factory";
import type { Instrument } from "@/model/types/instrument";
import type { InstrumentModules } from "@/model/types/instrument-modules";
import type { EventVoice, EventVoiceList } from "@/model/types/event-voice";
import {
    applyModuleParamChange,
    getCurrentValueForParam
} from "@/services/audio/module-automation";

vi.mock( "@/services/audio/module-router", () => ({
    applyRouting: vi.fn()
}));

/**
 * minimal AudioParam implementation that mimics the scheduling behaviour of
 * real Web Audio AudioParams: scheduled setValueAtTime() calls update the
 * parameters current value so subsequent getCurrentValueForParam() reads
 * operate on the same data an actual AudioContext would expose.
 */
class FakeAudioParam {
    public value: number;
    public readonly cancelScheduledValues = vi.fn();
    public readonly setValueAtTime = vi.fn(( value: number ): void => {
        this.value = value;
    });
    public readonly linearRampToValueAtTime = vi.fn(( value: number ): void => {
        this.value = value;
    });

    constructor( value = 0 ) {
        this.value = value;
    }
}

const createParamNode = ( value = 0 ): AudioParam => new FakeAudioParam( value ) as unknown as AudioParam;

const createFakeModules = (): InstrumentModules => {
    const filterFrequency = createParamNode( Config.DEFAULT_FILTER_FREQ );
    const filterQ         = createParamNode( Config.DEFAULT_FILTER_Q );
    const lfoFrequency    = createParamNode( Config.DEFAULT_FILTER_LFO_SPEED );
    // lfoAmp gain defaults to ( depth / 100 ) * filter frequency, see ModuleFactory.createFilter
    const lfoAmpGain      = createParamNode( Config.DEFAULT_FILTER_LFO_DEPTH / 100 * Config.DEFAULT_FILTER_FREQ );

    return {
        analyser: { disconnect: vi.fn() } as unknown as AnalyserNode,
        output:   { disconnect: vi.fn(), gain: createParamNode( 1 ) } as unknown as GainNode,
        panner:   { disconnect: vi.fn(), pan: createParamNode( 0 ) } as unknown as StereoPannerNode,
        eq: {
            lowBand:  {} as BiquadFilterNode,
            midBand:  {} as GainNode,
            highBand: {} as BiquadFilterNode,
            lowGain:  { gain: createParamNode( 1 ) } as GainNode,
            midGain:  { gain: createParamNode( 1 ) } as GainNode,
            highGain: { gain: createParamNode( 1 ) } as GainNode,
            output:   { disconnect: vi.fn() } as unknown as AudioNode,
            eqEnabled: false
        },
        overdrive: {
            overdrive: {
                disconnect: vi.fn(),
                drive: 0.8,
                preBand: 1,
                color: 4000,
                postCut: 8000
            } as unknown as InstrumentModules[ "overdrive" ][ "overdrive" ],
            overdriveEnabled: false
        },
        filter: {
            filter: {
                disconnect: vi.fn(),
                frequency: filterFrequency,
                Q: filterQ
            } as unknown as BiquadFilterNode,
            lfo: {
                frequency: lfoFrequency
            } as unknown as OscillatorNode,
            lfoAmp: {
                gain: lfoAmpGain
            } as unknown as GainNode,
            lfoEnabled: false,
            filterEnabled: false
        },
        delay: {
            delay: {
                input: {},
                output: {},
                type: 0,
                delay: 0.5,
                feedback: 0.42,
                offset: -0.027,
                cutoff: 1200,
                dry: 1
            },
            delayEnabled: false
        },
        voices: []
    } as unknown as InstrumentModules;
};

const createFakeInstrument = (): Instrument => ({
    index: 0,
    name: "Instrument 1",
    presetName: null,
    oscillators: [],
    volume: 1,
    panning: 0,
    muted: false,
    solo: false,
    filter: {
        enabled: false,
        frequency: Config.DEFAULT_FILTER_FREQ,
        q: Config.DEFAULT_FILTER_Q,
        speed: Config.DEFAULT_FILTER_LFO_SPEED,
        depth: Config.DEFAULT_FILTER_LFO_DEPTH,
        type: "lowpass",
        lfoType: "off"
    },
    delay: {
        enabled: false,
        type: 0,
        time: 0.5,
        feedback: 0.5,
        dry: 1,
        cutoff: 880,
        offset: 0,
        sync: false
    }
}) as unknown as Instrument;

const createAutomationEvent = ( module: string, value: number, glide = false, mpLength = 1 ): EffluxAudioEvent => {
    const event = EventFactory.create( 0 );
    event.mp = EventFactory.createModuleParam( module, value, glide );
    event.seq.mpLength = mpLength;
    return event;
};

const createVoice = (): EventVoice => ({
    generator: {
        frequency: createParamNode( 440 )
    } as unknown as OscillatorNode,
    gain: {
        gain: createParamNode( 1 )
    } as unknown as GainNode,
    outputNode: { gain: createParamNode( 1 ) } as unknown as GainNode,
    frequency: 440,
    vo: {} as EventVoice[ "vo" ],
    gliding: false
});

describe( "module-automation", () => {
    let modules: InstrumentModules;
    let instrument: Instrument;

    beforeEach(() => {
        modules = createFakeModules();
        instrument = createFakeInstrument();
        vi.clearAllMocks();
    });

    describe( "getCurrentValueForParam / applyModuleParamChange round trip conversions", () => {
        const START_TIME = 4;

        const assertRoundTrip = ( module: string, writtenValue: number, readValue: number = writtenValue ): void => {
            const event = createAutomationEvent( module, writtenValue );
            applyModuleParamChange(
                { currentTime: 0 } as unknown as BaseAudioContext,
                event, modules, instrument, [], START_TIME,
                { disconnect: vi.fn() } as unknown as AudioNode
            );
            expect( getCurrentValueForParam( modules, instrument, module )).toBeCloseTo( readValue, 5 );
        };

        it( "should restore written boolean enabled parameters (0 and 100)", () => {
            [ EQ_ENABLED, OD_ENABLED, FILTER_ENABLED, DELAY_ENABLED ].forEach( module => {
                assertRoundTrip( module, 100 );
                expect( getCurrentValueForParam( modules, instrument, module )).toBe( 100 );
                assertRoundTrip( module, 0 );
                expect( getCurrentValueForParam( modules, instrument, module )).toBe( 0 );
            });
        });

        it( "should treat values at or above 50 as enabled for boolean parameters", () => {
            [ EQ_ENABLED, OD_ENABLED, FILTER_ENABLED, DELAY_ENABLED ].forEach( module => {
                assertRoundTrip( module, 50, 100 );
                expect( getCurrentValueForParam( modules, instrument, module )).toBe( 100 );
                assertRoundTrip( module, 49.9, 0 );
                expect( getCurrentValueForParam( modules, instrument, module )).toBe( 0 );
            });
        });

        it( "should restore the filter LFO enabled state", () => {
            assertRoundTrip( FILTER_LFO_ENABLED, 0 );
            expect( instrument.filter.lfoType ).toBe( "off" );
            expect( getCurrentValueForParam( modules, instrument, FILTER_LFO_ENABLED )).toBe( 0 );

            assertRoundTrip( FILTER_LFO_ENABLED, 100 );
            expect( instrument.filter.lfoType ).not.toBe( "off" );
            expect( getCurrentValueForParam( modules, instrument, FILTER_LFO_ENABLED )).toBe( 100 );
        });

        it( "should restore equalizer gain values", () => {
            [ EQ_LOW, EQ_MID, EQ_HIGH ].forEach( module => {
                [ 0, 25, 50, 72.5, 100 ].forEach( value => assertRoundTrip( module, value ));
            });
        });

        it( "should restore overdrive values", () => {
            [ OD_DRIVE, OD_PRE_BAND ].forEach( module => {
                [ 0, 33.3, 66.6, 100 ].forEach( value => assertRoundTrip( module, value ));
            });
            [ OD_COLOR, OD_POST_CUT ].forEach( module => {
                [ 0, 25, 50, 75, 100 ].forEach( value => assertRoundTrip( module, value ));
            });
        });

        it( "should restore filter frequency, Q and LFO speed values", () => {
            [ FILTER_FREQ, FILTER_Q, FILTER_LFO_SPEED ].forEach( module => {
                [ 0, 10, 37.5, 62.5, 100 ].forEach( value => assertRoundTrip( module, value ));
            });
        });

        it( "should restore the filter LFO depth value", () => {
            [ 0, 10, 42, 50, 78, 100 ].forEach( value => assertRoundTrip( FILTER_LFO_DEPTH, value ));

            // LFO depth is relative to the filter frequency, verify the read value follows
            // both a depth change and a frequency change without drifting
            modules.filter.filter.frequency.value = 1100;
            assertRoundTrip( FILTER_LFO_DEPTH, 50 );
            modules.filter.filter.frequency.value = 2200;
            assertRoundTrip( FILTER_LFO_DEPTH, 50 );
        });

        it( "should not return NaN for LFO depth when the filter frequency is zero", () => {
            modules.filter.filter.frequency.value = 0;
            expect( getCurrentValueForParam( modules, instrument, FILTER_LFO_DEPTH )).toBe( 0 );
        });

        it( "should restore delay time, feedback and dry mix values", () => {
            [ DELAY_TIME, DELAY_FEEDBACK, DELAY_DRY ].forEach( module => {
                [ 0, 12.5, 50, 87.5, 100 ].forEach( value => assertRoundTrip( module, value ));
            });
        });

        it( "should restore the delay cutoff value without drifting into the offset", () => {
            [ 0, 15, 45, 70, 100 ].forEach( value => assertRoundTrip( DELAY_CUTOFF, value ));

            // explicitly verify the regression: applying a cutoff automation must leave
            // the offset untouched and reading back the offset must still be its own value
            const offsetBefore = modules.delay.delay.offset;
            applyModuleParamChange(
                { currentTime: 0 } as unknown as BaseAudioContext,
                createAutomationEvent( DELAY_CUTOFF, 60 ),
                modules, instrument, [], START_TIME,
                { disconnect: vi.fn() } as unknown as AudioNode
            );
            expect( modules.delay.delay.offset ).toBe( offsetBefore );
            assertRoundTrip( DELAY_OFFSET, 25 );
            assertRoundTrip( DELAY_OFFSET, 75 );
        });

        it( "should restore panning values for both left and right channels", () => {
            // PAN_LEFT stores a negative pan value, PAN_RIGHT the positive value,
            // both must round trip through the shared StereoPannerNode
            [ 0, 10, 33.3, 66.6, 100 ].forEach( value => {
                assertRoundTrip( PAN_RIGHT, value );
                assertRoundTrip( PAN_LEFT, value );
            });
            // the panner ends at the negative (left) value of the last write
            expect( getCurrentValueForParam( modules, instrument, PAN_RIGHT )).toBeCloseTo( -100, 5 );
            expect( getCurrentValueForParam( modules, instrument, PAN_LEFT )).toBeCloseTo( 100, 5 );
        });
    });

    describe( "glide state management on scheduled parameter changes", () => {
        const applyVolumeAutomation = (
            voiceLists: EventVoiceList[], value: number, glide: boolean, startTime: number, mpLength = 1
        ): void => {
            applyModuleParamChange(
                { currentTime: 0 } as unknown as BaseAudioContext,
                createAutomationEvent( VOLUME, value, glide, mpLength ),
                modules, instrument, voiceLists, startTime,
                { disconnect: vi.fn() } as unknown as AudioNode
            );
        };

        it( "should anchor the first glide at the current value and track its completion time", () => {
            const voice = createVoice();
            voice.gain.gain.value = 0.4;

            applyVolumeAutomation([[ voice ]], 80, true, 2, 1 );

            expect( voice.gliding ).toBe( true );
            expect( voice.glideEnd ).toBe( 3 );
            expect( voice.gain.gain.cancelScheduledValues ).toHaveBeenCalledWith( 2 );
            expect( voice.gain.gain.setValueAtTime ).toHaveBeenCalledWith( 0.4, 2 );
            expect( voice.gain.gain.linearRampToValueAtTime ).toHaveBeenCalledWith( 0.8, 3 );
        });

        it( "should extend the same ramp for consecutive glides while a glide is still in progress", () => {
            const voice = createVoice();

            applyVolumeAutomation([[ voice ]], 50, true, 0, 2 );

            expect( voice.gliding ).toBe( true );
            expect( voice.glideEnd ).toBe( 2 );

            // second automation arrives before the first glide has finished
            applyVolumeAutomation([[ voice ]], 100, true, 1, 2 );

            // no re-anchoring: existing scheduled values are preserved to keep the ramp continuous
            expect( voice.gain.gain.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
            expect( voice.gain.gain.setValueAtTime ).toHaveBeenCalledTimes( 1 );
            expect( voice.gain.gain.linearRampToValueAtTime ).toHaveBeenLastCalledWith( 1, 3 );
            expect( voice.gliding ).toBe( true );
            expect( voice.glideEnd ).toBe( 3 );
        });

        it( "should reset the gliding state once a glide has completed and restart the next glide from the current value", () => {
            const voice = createVoice();
            voice.gain.gain.value = 0.25;

            // first glide runs from t=0 to t=1
            applyVolumeAutomation([[ voice ]], 50, true, 0, 1 );
            expect( voice.gliding ).toBe( true );
            expect( voice.glideEnd ).toBe( 1 );

            // simulate the ramp having reached its target (e.g. the same event retriggered on a loop)
            voice.gain.gain.value = 0.5;

            // new automation starts at or after the previous glides end time: a fresh glide must begin
            applyVolumeAutomation([[ voice ]], 100, true, 1, 1 );

            expect( voice.gliding ).toBe( true );
            expect( voice.glideEnd ).toBe( 2 );
            expect( voice.gain.gain.cancelScheduledValues ).toHaveBeenCalledTimes( 2 );
            expect( voice.gain.gain.cancelScheduledValues ).toHaveBeenLastCalledWith( 1 );
            expect( voice.gain.gain.setValueAtTime ).toHaveBeenLastCalledWith( 0.5, 1 );
            expect( voice.gain.gain.linearRampToValueAtTime ).toHaveBeenLastCalledWith( 1, 2 );
        });

        it( "should repeatedly retrigger glides across multiple loop iterations", () => {
            const voice = createVoice();
            voice.gain.gain.value = 1;

            for ( let loop = 0; loop < 3; ++loop ) {
                const loopStart = loop * 4;
                // each loop re-triggers the same automation after the previous glide has ended,
                // update the AudioParam value before scheduling so the new ramp anchors at it
                const currentValue = 0.25 + loop * 0.25;
                voice.gain.gain.value = currentValue;
                applyVolumeAutomation([[ voice ]], 75, true, loopStart, 1 );

                expect( voice.gliding ).toBe( true );
                expect( voice.glideEnd ).toBe( loopStart + 1 );
                // every iteration must anchor a fresh ramp instead of silently extending an expired one
                expect( voice.gain.gain.setValueAtTime ).toHaveBeenLastCalledWith( currentValue, loopStart );
                expect( voice.gain.gain.linearRampToValueAtTime ).toHaveBeenLastCalledWith( 0.75, loopStart + 1 );
            }
            expect( voice.gain.gain.setValueAtTime ).toHaveBeenCalledTimes( 3 );
        });

        it( "should reset the gliding state when an instant non-gliding change interrupts a glide", () => {
            const voice = createVoice();

            applyVolumeAutomation([[ voice ]], 50, true, 0, 2 );
            expect( voice.gliding ).toBe( true );

            applyVolumeAutomation([[ voice ]], 25, false, 1 );

            expect( voice.gliding ).toBe( false );
            expect( voice.glideEnd ).toBeUndefined();
            expect( voice.gain.gain.cancelScheduledValues ).toHaveBeenLastCalledWith( 1 );
            expect( voice.gain.gain.setValueAtTime ).toHaveBeenLastCalledWith( 0.25, 1 );

            // a following glide must start fresh now that the glide state has been reset
            applyVolumeAutomation([[ voice ]], 100, true, 2, 1 );
            expect( voice.gliding ).toBe( true );
            expect( voice.gain.gain.setValueAtTime ).toHaveBeenLastCalledWith( 0.25, 2 );
            expect( voice.gain.gain.linearRampToValueAtTime ).toHaveBeenLastCalledWith( 1, 3 );
        });

        it( "should apply the same glide state handling to pitch automation on oscillator voices", () => {
            const voice = createVoice();

            const applyPitch = ( value: number, startTime: number, glide: boolean, mpLength = 1 ): void => {
                applyModuleParamChange(
                    { currentTime: 0 } as unknown as BaseAudioContext,
                    createAutomationEvent( PITCH_UP, value, glide, mpLength ),
                    modules, instrument, [[ voice ]], startTime,
                    { disconnect: vi.fn() } as unknown as AudioNode
                );
            };

            applyPitch( 50, 0, true );
            expect( voice.gliding ).toBe( true );
            expect( voice.glideEnd ).toBe( 1 );

            // in-progress glide extends the ramp without re-anchoring (glideEnd moves to 1.5)
            const anchorCalls = ( voice.generator as OscillatorNode ).frequency.setValueAtTime;
            applyPitch( 75, 0.5, true );
            expect( anchorCalls ).toHaveBeenCalledTimes( 1 );
            expect( voice.glideEnd ).toBe( 1.5 );

            // after completion a retriggered event starts a new glide
            applyPitch( 25, 2, true );
            expect( voice.gliding ).toBe( true );
            expect( voice.glideEnd ).toBe( 3 );
            expect( anchorCalls ).toHaveBeenCalledTimes( 2 );
        });

        it( "should not require glide tracking state for module parameters that schedule directly on a node", () => {
            // panning automations schedule on the shared panner node (no per-voice tracking object),
            // consecutive glides are appended as ramps and no tracking state is expected to exist
            const event1 = createAutomationEvent( PAN_RIGHT, 50, true, 1 );
            const event2 = createAutomationEvent( PAN_RIGHT, 100, true, 1 );

            applyModuleParamChange(
                { currentTime: 0 } as unknown as BaseAudioContext,
                event1, modules, instrument, [], 0,
                { disconnect: vi.fn() } as unknown as AudioNode
            );
            applyModuleParamChange(
                { currentTime: 0 } as unknown as BaseAudioContext,
                event2, modules, instrument, [], 1,
                { disconnect: vi.fn() } as unknown as AudioNode
            );

            expect( modules.panner.pan.linearRampToValueAtTime ).toHaveBeenCalledTimes( 2 );
            expect( modules.panner.pan.linearRampToValueAtTime ).toHaveBeenLastCalledWith( 1, 2 );
        });
    });
});
