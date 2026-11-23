import { FloatGyroSampleLayout } from './FloatGyroSampleLayout';
import { FLOAT_SAMPLE_SIZE } from './gyroLayouts';
import type { GyroSampleLayout } from './GyroSampleLayout';
import { RawGyroSampleLayout } from './RawGyroSampleLayout';
import { SampleColumns } from './SampleColumns';
import { ByteReader } from '../../../../shared/binary/ByteReader';
import { GyroViewError, hasErrorCode } from '../../../../shared/errors/GyroViewError';
import type { Vector3 } from '../../../../shared/math/Vector3';
import type { GyroSample, GyroTrack } from '../../../motion/gyro/GyroTrack';
import { repairedTimeline } from '../../../motion/gyro/repairedTimeline';
import type { SensorRanges } from '../../info/RecordingInfo';

/**
 * Plausible spacing between consecutive samples when guessing the layout: 100 Hz to 10 kHz.
 */
const MIN_PLAUSIBLE_INTERVAL_US = 100;
const MAX_PLAUSIBLE_INTERVAL_US = 10_000;
/**
 * The samples the layout is told from when the info record does not say: enough that a few
 * uninitialised or glitched stamps at the start are outvoted, in one small read.
 */
const SAMPLES_TO_GUESS_FROM = 32;
/**
 * The fewest usable samples a layout must decode a stamp from before its spacing can decide:
 * one interval needs two samples, and a record with fewer than that says nothing.
 */
const MIN_SAMPLES_TO_GUESS_FROM = 2;
/**
 * Readings past these are no motion a camera makes: the X5 declares a 32 g and a 2000 degrees a
 * second (35 rad/s) range. A flipped bit in a float64 reading lands far beyond them, or at NaN.
 */
const MAX_PLAUSIBLE_ACCELERATION_G = 64;
const MAX_PLAUSIBLE_ANGULAR_VELOCITY_RAD_S = 100;

export interface GyroLayoutHints {
  /**
   * `is_raw_gyro` from the info record when present; otherwise the layout is inferred from the
   * timestamps the candidate layouts decode.
   */
  readonly isRawGyro: boolean | undefined;
  readonly ranges: Partial<SensorRanges> | undefined;
}

export interface ParsedGyroRecord {
  readonly track: GyroTrack;
  /**
   * The name of the sample layout the record was read with.
   */
  readonly layout: string;
  /**
   * Bytes after the last whole sample. Real ONE R recordings carry one; they are ignored.
   */
  readonly strayBytes: number;
  /**
   * Samples left out because their bytes cannot be a reading (see {@link parseGyroRecord}).
   */
  readonly damagedSamples: number;
  /**
   * Slots left all zero, as a camera leaves the first ones it never wrote: left out too, but no
   * damage.
   */
  readonly unwrittenSamples: number;
  /**
   * Stamps put back where their neighbours say they belong (see {@link repairedTimeline}).
   */
  readonly mendedStamps: number;
}

/**
 * Enough leading bytes of a gyro record to tell its layout, in samples of the larger layout.
 */
export const GYRO_LAYOUT_PROBE_SIZE = FLOAT_SAMPLE_SIZE * SAMPLES_TO_GUESS_FROM;

/**
 * The sample layout of the gyro record: from the info record's flag when present, otherwise from
 * the samples the candidates decode in the record's first bytes (`head`). Undefined when there is
 * neither a flag nor a record to look at.
 *
 * Guessing judges the bytes by the parser's own sample validity (see {@link evidenceOf}): a slot
 * the camera left all zero, a slot whose bytes cannot be a reading and a stamp the parser would
 * mend as stray are all left out before the spacing between stamps is measured. A damaged start
 * therefore cannot pull the guess either way, and a record with too few usable samples is
 * refused with a reason instead of being misread.
 */
export function selectGyroSampleLayout(
  hints: GyroLayoutHints,
  head: Uint8Array | undefined,
): GyroSampleLayout | undefined {
  const raw = new RawGyroSampleLayout(hints.ranges);
  const float = new FloatGyroSampleLayout();
  if (hints.isRawGyro !== undefined) return hints.isRawGyro ? raw : float;
  if (head === undefined) return undefined;
  const candidates = [raw, float].map((layout) => ({ layout, evidence: evidenceOf(head, layout) }));
  const plausible = candidates.filter(({ evidence }) => isPlausibleFit(evidence));
  const [winner] = plausible;
  if (winner && plausible.length === 1) return winner.layout;
  throw new GyroViewError(
    'unsupported-gyro-record',
    `cannot tell the gyro sample layout from the first ${head.byteLength} bytes without the info record: ${reasonNothingFits(candidates, plausible.length)}`,
  );
}

/**
 * What the leading samples say about one candidate layout, judged by the same validity the
 * parser applies to every sample.
 */
interface LayoutEvidence {
  /**
   * Whole samples the probe holds in this layout.
   */
  readonly slots: number;
  /**
   * Slots the camera never wrote: all zero, left out before any other rule.
   */
  readonly unwrittenSamples: number;
  /**
   * Slots that hold a sample the parser would keep: neither unwritten nor damaged, and with its
   * stamp not mended as stray.
   */
  readonly trustedSamples: number;
  /**
   * Steps between consecutive trusted samples that are a plausible IMU interval.
   */
  readonly plausibleSteps: number;
}

/**
 * A layout fits when the samples it decodes step at a plausible IMU interval: at least two
 * trusted samples, at least half of the written slots holding one (a wrong layout damages nearly
 * all of them), and at least half of the intervals between them plausible (damaged bytes step at
 * no interval an IMU writes). A knock or a vibration changes readings, not stamps, so it decides
 * nothing here.
 */
function isPlausibleFit(evidence: LayoutEvidence): boolean {
  const written = evidence.slots - evidence.unwrittenSamples;
  const intervals = Math.max(evidence.trustedSamples - 1, 0);
  return (
    evidence.trustedSamples >= MIN_SAMPLES_TO_GUESS_FROM &&
    evidence.trustedSamples * 2 >= written &&
    evidence.plausibleSteps * 2 >= intervals
  );
}

/**
 * Why no single layout explains the probe: too few usable samples to tell, several layouts that
 * each could, or samples that step at no plausible interval.
 */
function reasonNothingFits(
  candidates: readonly { readonly evidence: LayoutEvidence }[],
  plausibleCount: number,
): string {
  if (plausibleCount > 1) return 'both layouts explain its samples';
  const [best] = candidates.toSorted(
    (left, right) => right.evidence.trustedSamples - left.evidence.trustedSamples,
  );
  const evidence = best?.evidence;
  if (!evidence) return 'there are no samples to tell from';
  const tooFew = `too few usable samples (${evidence.trustedSamples} of ${evidence.slots} slots, the rest unwritten or damaged)`;
  return evidence.trustedSamples >= MIN_SAMPLES_TO_GUESS_FROM
    ? 'no layout decodes sample stamps that step at a plausible IMU interval'
    : tooFew;
}

/**
 * A slot the camera never wrote, told apart from one whose bytes cannot be a reading.
 */
const UNWRITTEN = 'unwritten';

/**
 * Decodes the gyro record payload into a {@link GyroTrack} with the given layout. Whole samples
 * only: a partial sample at the end is tolerated and reported, never rejected. So is a sample whose
 * bytes cannot be a reading (a stamp past the safe integers, a value no camera measures, a
 * component a flipped bit moved) and a slot left all zero: each sample carries its own time, so
 * the others still count.
 * Stamps that stray from their neighbours are mended (see {@link repairedTimeline}).
 */
export function parseGyroRecord(payload: Uint8Array, layout: GyroSampleLayout): ParsedGyroRecord {
  const count = Math.floor(payload.byteLength / layout.sampleSize);
  const reader = new ByteReader(payload);
  const columns = new SampleColumns(count);
  let unwritten = 0;
  for (let index = 0; index < count; index += 1) {
    const slot = slotAt(reader, layout, index * layout.sampleSize);
    if (slot === UNWRITTEN) unwritten += 1;
    else if (slot) columns.push(slot);
  }
  columns.dropFlippedBits(layout.flipSteps);
  const timeline = repairedTimeline(columns.captureTimes());
  return {
    track: columns.toTrack(timeline.times),
    layout: layout.name,
    strayBytes: payload.byteLength % layout.sampleSize,
    damagedSamples: count - unwritten - columns.length,
    unwrittenSamples: unwritten,
    mendedStamps: timeline.mended,
  };
}

/**
 * The reading in one slot; undefined when its bytes cannot be one.
 */
function slotAt(
  reader: ByteReader,
  layout: GyroSampleLayout,
  offset: number,
): GyroSample | typeof UNWRITTEN | undefined {
  try {
    const captureTime = layout.timestampAt(reader, offset);
    if (captureTime === 0 && isUnwritten(reader.bytesAt(offset, layout.sampleSize)))
      return UNWRITTEN;
    const sample = {
      captureTime,
      acceleration: layout.accelerationAt(reader, offset),
      angularVelocity: layout.angularVelocityAt(reader, offset),
    };
    const isReading =
      isWithin(sample.acceleration, MAX_PLAUSIBLE_ACCELERATION_G) &&
      isWithin(sample.angularVelocity, MAX_PLAUSIBLE_ANGULAR_VELOCITY_RAD_S);
    return isReading ? sample : undefined;
  } catch (error) {
    if (hasErrorCode(error, 'binary-unsafe-integer')) return undefined;
    throw error;
  }
}

/**
 * A sample left all zero, as a camera leaves the first slots it never wrote: in the raw layout
 * it would read the negative full range on every axis, which no sensor measures.
 */
function isUnwritten(sample: Uint8Array): boolean {
  return sample.every((byte) => byte === 0);
}

function isWithin(vector: Vector3, bound: number): boolean {
  return vector.every((component) => Math.abs(component) <= bound);
}

/**
 * What the leading samples say about one candidate layout, judged by the very pipeline the
 * parser applies to every sample: {@link slotAt} leaves out a slot the camera never wrote and one
 * whose bytes cannot be a reading (a stamp past the safe integers, a value no camera measures),
 * a component a flipped bit moved is dropped (see {@link SampleColumns.dropFlippedBits}), and a
 * stamp the parser would mend as stray (see {@link repairedTimeline}) is left out of the step
 * evidence. The spacing is measured between the stamps that survive, as recorded: mending every
 * stamp onto a grid would make damaged bytes look regular, so only the intervals the bytes
 * themselves show are trusted.
 */
function evidenceOf(payload: Uint8Array, layout: GyroSampleLayout): LayoutEvidence {
  const reader = new ByteReader(payload);
  const slots = Math.min(Math.floor(payload.byteLength / layout.sampleSize), SAMPLES_TO_GUESS_FROM);
  const columns = new SampleColumns(slots);
  let unwrittenSamples = 0;
  for (let index = 0; index < slots; index += 1) {
    const slot = slotAt(reader, layout, index * layout.sampleSize);
    if (slot === UNWRITTEN) unwrittenSamples += 1;
    else if (slot) columns.push(slot);
  }
  columns.dropFlippedBits(layout.flipSteps);
  const trusted = trustedStamps(columns.captureTimes());
  return {
    slots,
    unwrittenSamples,
    trustedSamples: trusted.length,
    plausibleSteps: countPlausibleSteps(trusted),
  };
}

/**
 * The stamps {@link repairedTimeline} would leave where they are: a stray one is left out of the
 * step evidence, as the parser mends it instead of trusting it.
 */
function trustedStamps(recorded: Float64Array): number[] {
  const { times } = repairedTimeline(recorded);
  return [...times].filter((time, index) => time === recorded[index]);
}

function countPlausibleSteps(times: readonly number[]): number {
  let plausibleSteps = 0;
  for (let index = 1; index < times.length; index += 1) {
    if (isPlausibleInterval((times[index] ?? 0) - (times[index - 1] ?? 0))) plausibleSteps += 1;
  }
  return plausibleSteps;
}

/**
 * Spacing a camera's IMU writes between samples: 100 Hz to 10 kHz.
 */
function isPlausibleInterval(intervalUs: number): boolean {
  return intervalUs >= MIN_PLAUSIBLE_INTERVAL_US && intervalUs <= MAX_PLAUSIBLE_INTERVAL_US;
}
