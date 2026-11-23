import { describe, expect, it } from 'vitest';

import { inspectRecording } from './inspectRecording';
import { RecordType } from '../../domain/format/constants';
import { GYRO_LAYOUT_PROBE_SIZE } from '../../domain/format/records/gyro/parseGyroRecord';
import {
  RAW_ACCELERATION_OFFSET,
  RAW_ANGULAR_VELOCITY_OFFSET,
  RAW_COMPONENT_SIZE,
  RAW_SAMPLE_SIZE,
  RAW_ZERO_POINT,
} from '../../domain/format/records/gyro/gyroLayouts';
import { InMemoryRandomAccessSource } from '../../testing/InMemoryRandomAccessSource';
import { minimalInfoRecord } from '../../testing/minimalInfoRecord';
import { officeRecords, type OfficeRecordingParts } from '../../../test/support/officeRecording';

/**
 * Bytes no gyro sample layout explains: every field at its maximum.
 */
const UNEXPLAINED_GYRO = new Uint8Array(GYRO_LAYOUT_PROBE_SIZE).fill(0xff);

/**
 * A raw-layout sample at rest: a microsecond stamp, gravity on y and no rotation. The word is
 * scaled for the default 16 g range, which a record with no info ranges is read under.
 */
function encodeRawSample(timestampUs: number): Uint8Array {
  const bytes = new Uint8Array(RAW_SAMPLE_SIZE);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(timestampUs), true);
  for (let axis = 0; axis < 3; axis += 1) {
    const acceleration = RAW_ZERO_POINT + (axis === 1 ? -2048 : 0);
    view.setUint16(RAW_ACCELERATION_OFFSET + axis * RAW_COMPONENT_SIZE, acceleration, true);
    view.setUint16(RAW_ANGULAR_VELOCITY_OFFSET + axis * RAW_COMPONENT_SIZE, RAW_ZERO_POINT, true);
  }
  return bytes;
}

function inspectOffice(parts: OfficeRecordingParts = {}): ReturnType<typeof inspectRecording> {
  const file = officeRecords(parts).buildContiguous();
  return inspectRecording(new InMemoryRandomAccessSource(file.bytes));
}

function flipBit(bytes: Uint8Array, index: number, mask: number): Uint8Array {
  const flipped = Uint8Array.from(bytes);
  flipped[index] = (flipped[index] ?? 0) ^ mask;
  return flipped;
}

describe('inspectRecording', () => {
  it('summarises the boxes, the trailer, the calibration, the gyro and the exposure', async () => {
    const file = officeRecords().buildContiguous();
    const inspection = await inspectRecording(new InMemoryRandomAccessSource(file.bytes));
    expect(inspection).toMatchObject({
      fileSize: file.bytes.byteLength,
      trailerWrapper: 'bare',
      payloadStart: file.payloadStart,
      info: { model: 'Insta360 X5' },
      calibration: { lenses: [{ lensIndex: 0 }, { lensIndex: 1 }] },
      gyro: { layout: 'raw', samples: 2000, damagedSamples: 0, unwrittenSamples: 0 },
      exposure: { entries: 16 },
    });
    expect(inspection.records.map((record) => record.id)).toEqual([
      RecordType.Info,
      RecordType.Gyro,
      RecordType.Exposure,
    ]);
  });

  it('reads a damaged raw record with no info flag, telling the layout from what is left', async () => {
    const samples = Array.from({ length: 40 }, (_unused, index) =>
      encodeRawSample(5_000_000 + index * 1000),
    );
    for (const index of [0, 9, 20]) samples[index] = new Uint8Array(RAW_SAMPLE_SIZE);
    samples[4] = flipBit(samples[4] ?? new Uint8Array(), 7, 0x80);
    samples[15] = flipBit(samples[15] ?? new Uint8Array(), 6, 0x01);
    const gyro = new Uint8Array(samples.flatMap((sample) => [...sample]));
    const info = minimalInfoRecord({ model: 'Insta360 X5' });
    const inspection = await inspectOffice({ info, gyro });
    expect(inspection.gyro).toMatchObject({
      layout: 'raw',
      samples: 36,
      unwrittenSamples: 3,
      damagedSamples: 1,
      strayBytes: 0,
      meanAccelerationMagnitudeG: expect.closeTo(1, 1) as number,
    });
  });

  it('reports a gyro layout it cannot tell, and the exposure it therefore leaves unread', async () => {
    // Without the info record's raw-gyro flag, only the samples could tell the layout.
    const info = minimalInfoRecord({ model: 'Insta360 X5' });
    const inspection = await inspectOffice({ info, gyro: UNEXPLAINED_GYRO });
    expect(inspection.gyro).toMatchObject({ unreadable: expect.any(String) as string });
    expect(inspection.exposure).toEqual({ unread: 'gyro layout unknown' });
  });

  it('reports a gyro record whose samples are mostly unreadable as unreadable', async () => {
    const info = minimalInfoRecord({ model: 'Insta360 X5' });
    const garbage = new Uint8Array(RAW_SAMPLE_SIZE * 64);
    for (let index = 0; index < garbage.length; index += 1)
      garbage[index] = (index * 37 + 11) & 0xff;
    const inspection = await inspectOffice({ info, gyro: garbage });
    expect(inspection.gyro).toMatchObject({
      unreadable: expect.stringContaining('too few usable samples') as string,
    });
  });

  it('has no gyro summary for a recording without a gyro record', async () => {
    const inspection = await inspectOffice({ hasGyro: false });
    expect(inspection.gyro).toBeUndefined();
  });
});
