import { test, expect, type Page, type TestInfo } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { serveExport } from './helpers';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

function twoClipGlb() {
  const positions = Buffer.alloc(36);
  [-1, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, i) => positions.writeFloatLE(value, i * 4));
  const keys = Buffer.alloc(56);
  [0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 3, 0, 0].forEach((value, i) => keys.writeFloatLE(value, i * 4));
  const binary = Buffer.concat([positions, keys]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'MovingMesh' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 24 }, { buffer: 0, byteOffset: 68, byteLength: 24 }
    ],
    buffers: [{ byteLength: binary.length }],
    animations: [2, 3].map((output, index) => ({ name: index ? 'Second' : 'First',
      samplers: [{ input: 1, output, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }))
  };
  const text = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(json);
  const header = Buffer.alloc(12);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length); jsonHeader.write('JSON', 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length); binHeader.write('BIN\0', 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, binary]);
}

// 8 kHz mono 16-bit silence; `seconds` long.
function silentWav(seconds = 1) {
  const samples = 8000 * seconds;
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
  return wave;
}

async function openExport(page: Page, testInfo: TestInfo) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const directory = testInfo.outputPath('timeline-state-export');
  page.once('dialog', dialog => dialog.accept());
  await page.goto(await serveExport(page, zip, directory));
}

async function scrollTo(page: Page, fraction: number) {
  await page.locator('.engine-web-scroll').evaluate((element, value) => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * value;
  }, fraction);
}

const position = (page: Page) => page.locator('body').getAttribute('data-clip-position').then(value => Number(value));

async function setUpTwoClipModel(page: Page) {
  await page.locator('#model-upload').setInputFiles({ name: 'animated.glb', mimeType: 'model/gltf-binary', buffer: twoClipGlb() });
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'JavaScript' }).click();
  await page.getByLabel('Object script').fill("return { update() { document.body.dataset.clipPosition = String(object.getObjectByName('MovingMesh').position.x); } };");
}

test('clip seeking, segment gaps, sound offsets and stop() stay consistent', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createTimelineMedia } = await import('/src/systems/TimelineMedia.ts');
    const THREE = await import('/node_modules/three/build/three.module.js');

    const buildModel = () => {
      const root = new THREE.Object3D();
      const mesh = new THREE.Object3D();
      mesh.name = 'MovingMesh';
      root.add(mesh);
      root.animations = [
        new THREE.AnimationClip('First', 1, [new THREE.VectorKeyframeTrack('MovingMesh.position', [0, 1], [0, 0, 0, 1, 0, 0])]),
        new THREE.AnimationClip('Second', 1, [new THREE.VectorKeyframeTrack('MovingMesh.position', [0, 1], [1, 0, 0, 3, 0, 0])])
      ];
      return { root, mesh };
    };

    // One second of silent WAV as a data URL, used for the looping offset checks.
    const samples = 8000;
    const wave = new Uint8Array(44 + samples * 2);
    const view = new DataView(wave.buffer);
    let url = '';
    try {
      const text = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i++) wave[offset + i] = value.charCodeAt(i);
      };
      text(0, 'RIFF'); view.setUint32(4, wave.length - 8, true); text(8, 'WAVEfmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true);
      view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples * 2, true);
      let binary = '';
      for (let i = 0; i < wave.length; i++) binary += String.fromCharCode(wave[i]);
      url = `data:audio/wav;base64,${btoa(binary)}`;
    } catch {
      url = '';
    }

    const created: HTMLAudioElement[] = [];
    const NativeAudio = window.Audio;
    window.Audio = function (src?: string) {
      const audio = new NativeAudio(src);
      created.push(audio);
      return audio;
    } as unknown as typeof Audio;

    const waitForMetadata = (audio: HTMLAudioElement) => new Promise<void>(resolve => {
      const done = () => {
        setTimeout(resolve, 60);
      };
      if (audio.readyState >= 1) done();
      else {
        audio.addEventListener('loadedmetadata', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        setTimeout(done, 2000);
      }
    });

    try {
      const { root, mesh } = buildModel();
      const object = {
        id: 'model', name: 'Model', type: 'model', object: root,
        properties: { sounds: [{ id: 'sound', name: 'loop.wav', url, autoPlay: false, volume: 1, loop: true }] }
      };
      const timeline = {
        duration: 4, trigger: 'scroll', key: '', tracks: [],
        clips: [
          { id: 'first', targetId: 'model', clipIndex: 0, start: 0, duration: 1 },
          { id: 'second', targetId: 'model', clipIndex: 1, start: 2, duration: 2 }
        ],
        sounds: [
          { id: 'opening', targetId: 'model', soundId: 'sound', start: 0, duration: 1 },
          { id: 'closing', targetId: 'model', soundId: 'sound', start: 1.5, duration: 2.5 }
        ]
      };

      const errors: string[] = [];
      const media = createTimelineMedia(timeline, [object], THREE, message => errors.push(message), false);
      const [opening, closing] = created;
      await Promise.all([waitForMetadata(opening), waitForMetadata(closing)]);
      const durations = [opening.duration, closing.duration];

      const positions: number[] = [];
      const sample = (time: number) => { media.seek(time, true, true); positions.push(Number(mesh.position.x.toFixed(3))); };
      sample(0.5);   // inside the first clip
      sample(1.5);   // gap between clips: stop, never hold the last frame
      sample(2);     // second clip starts; relative time 0
      sample(2.5);   // second clip; relative time 0.5
      sample(2.1);   // backward jump inside the second clip; relative time 0.1
      sample(4);     // closing clip touches the timeline end: its last frame is kept
      sample(0.2);   // backward jump to the first clip

      const soundStates: { time: number; opening: [boolean, number]; closing: [boolean, number] }[] = [];
      const soundAt = async (time: number) => {
        media.seek(time, true, true);
        await new Promise(resolve => setTimeout(resolve, 60));
        soundStates.push({ time,
          opening: [opening.paused, opening.currentTime],
          closing: [closing.paused, closing.currentTime] });
      };
      await soundAt(0.4);    // opening segment
      await soundAt(1.7);    // only the closing segment
      await soundAt(3.4);    // closing offset 1.9s wraps to 0.9s of the one second file
      await soundAt(0.1);    // back into the opening segment

      media.stop();
      const released = [opening, closing].map(audio => ({
        paused: audio.paused, src: audio.getAttribute('src'), time: audio.currentTime
      }));
      media.seek(2.5, true, true);
      const ignoredAfterStop = Number(mesh.position.x.toFixed(3));

      const createdBeforeRestart = created.length;
      const fresh = createTimelineMedia(timeline, [object], THREE, message => errors.push(message), false);
      const [freshOpening, freshClosing] = created.slice(createdBeforeRestart);
      await Promise.all([waitForMetadata(freshOpening), waitForMetadata(freshClosing)]);
      fresh.seek(1.5, true, true);
      const gapAfterRestart = Number(mesh.position.x.toFixed(3));
      fresh.seek(2.5, true, true);
      const restartPosition = Number(mesh.position.x.toFixed(3));
      await new Promise(resolve => setTimeout(resolve, 60));
      const restartSound = [freshOpening.paused, freshClosing.paused];
      fresh.stop();
      const restartReleased = [freshOpening, freshClosing].map(audio => ({
        paused: audio.paused, src: audio.getAttribute('src'), time: audio.currentTime
      }));

      const createdBeforePreview = created.length;
      const preview = createTimelineMedia(timeline, [object], THREE, () => undefined, true);
      preview.seek(0.5, true, true);
      preview.stop();
      const previewCreated = created.length - createdBeforePreview;

      return { positions, soundStates, durations, errors, released, ignoredAfterStop, gapAfterRestart,
        restartPosition, restartSound, restartReleased, previewCreated, reused: freshOpening === opening || freshClosing === closing };
    } finally {
      window.Audio = NativeAudio;
    }
  });

  expect(result.durations).toEqual([1, 1]);
  expect(result.positions).toEqual([0.5, 0, 1, 2, 1.2, 3, 0.2]);
  expect(result.errors).toEqual([]);
  // A playing one second loop free-runs between the 60ms samples, so offsets are
  // checked against tolerant bands rather than exact float equality.
  const states = result.soundStates;
  const within = (value: number, low: number, high: number) => value >= low - 0.02 && value < high;
  expect(states.map(state => state.time)).toEqual([0.4, 1.7, 3.4, 0.1]);
  expect(states[0].opening[0]).toBe(false);
  expect(within(states[0].opening[1], 0.4, 0.5)).toBe(true);
  expect(states[0].closing[0]).toBe(true);
  expect(states[1].opening[0]).toBe(true);
  expect(within(states[1].opening[1], 0.4, 0.5)).toBe(true);
  expect(states[1].closing[0]).toBe(false);
  expect(within(states[1].closing[1], 0.2, 0.35)).toBe(true);
  expect(states[2].closing[0]).toBe(false);
  expect(within(states[2].closing[1], 0.9, 1)).toBe(true);   // 1.9s wrapped by the one second file
  expect(states[2].opening[0]).toBe(true);
  expect(states[3].opening[0]).toBe(false);
  expect(within(states[3].opening[1], 0.1, 0.25)).toBe(true);
  expect(states[3].closing[0]).toBe(true);
  expect(result.released).toEqual([
    { paused: true, src: null, time: 0 },
    { paused: true, src: null, time: 0 }
  ]);
  // stop() restores the pre-timeline pose and further seeks are ignored.
  expect(result.ignoredAfterStop).toBe(0);
  expect(result.gapAfterRestart).toBe(0);
  expect(result.restartPosition).toBe(2);
  expect(result.restartSound).toEqual([true, false]);
  expect(result.restartReleased).toEqual([
    { paused: true, src: null, time: 0 },
    { paused: true, src: null, time: 0 }
  ]);
  expect(result.previewCreated).toBe(0);
  expect(result.reused).toBe(false);
});

test('clips stop in gaps and resync on backward scroll in Play and export', async ({ page }, testInfo) => {
  await page.goto('/');
  await setUpTwoClipModel(page);
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline duration').fill('3');
  await page.getByLabel('Timeline trigger').selectOption('scroll');
  await page.getByRole('button', { name: 'Add GLB clip' }).click();
  await page.getByLabel('Timeline GLB clip').selectOption({ label: 'Second' });
  await page.getByRole('button', { name: 'Add GLB clip' }).click();
  await page.getByLabel('clip Second start').fill('2');
  await expect(page.getByLabel('clip Second start')).toHaveValue('2');
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Add web section' }).click();
    await page.getByLabel('Web parent').selectOption('');
  }
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();

  const check = async () => {
    await expect.poll(() => position(page)).toBeCloseTo(0, 1);
    await scrollTo(page, 5 / 6);   // second clip, relative time 0.5
    await expect.poll(() => position(page)).toBeCloseTo(2, 1);
    await scrollTo(page, 0.5);     // gap between the clips
    await expect.poll(() => position(page)).toBeCloseTo(0, 1);
    await scrollTo(page, 5 / 6);   // forward jump back into the second clip
    await expect.poll(() => position(page)).toBeCloseTo(2, 1);
    await scrollTo(page, 1 / 6);   // backward jump into the first clip, relative time 0.5
    await expect.poll(() => position(page)).toBeCloseTo(0.5, 1);
    await scrollTo(page, 1);       // closing clip touches the end: last frame
    await expect.poll(() => position(page)).toBeCloseTo(3, 1);
    await scrollTo(page, 0);       // backward jump resets the first clip
    await expect.poll(() => position(page)).toBeCloseTo(0, 1);
  };

  await check();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await openExport(page, testInfo);
  await expect.poll(() => position(page), { timeout: 15000 }).toBeCloseTo(0, 1);
  await check();
  await expect(page.locator('#load-error')).toBeHidden();
});

test('stopping and restarting Play rebuilds timeline clips and sounds', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      (window as Window & { timelinePlayed?: HTMLMediaElement[] }).timelinePlayed ??= [];
      (window as Window & { timelinePlayed: HTMLMediaElement[] }).timelinePlayed.push(this);
      return original.call(this);
    };
  });
  await page.goto('/');
  await setUpTwoClipModel(page);
  await page.getByRole('button', { name: 'Sounds', exact: true }).click();
  await page.locator('#sound-upload').setInputFiles({ name: 'restart.wav', mimeType: 'audio/wav', buffer: silentWav(1) });
  await expect(page.getByRole('region', { name: 'Sounds' }).getByText('restart.wav', { exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Sounds' }).locator('input[type="checkbox"]').nth(1).check();
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByLabel('Timeline duration').fill('3');
  await page.getByLabel('Timeline trigger').selectOption('key');
  await page.getByLabel('Timeline key').fill('t');
  await page.getByRole('button', { name: 'Add GLB clip' }).click();
  await page.getByLabel('Timeline GLB clip').selectOption({ label: 'Second' });
  await page.getByRole('button', { name: 'Add GLB clip' }).click();
  await page.getByLabel('clip Second start').fill('2');
  await page.getByRole('button', { name: 'Add object sound' }).click();
  await page.getByLabel('sound restart.wav start').fill('0');

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const played = () => page.evaluate(() =>
    (window as Window & { timelinePlayed?: HTMLMediaElement[] }).timelinePlayed?.length ?? 0);
  const audioState = (index: number) => page.evaluate((position: number) => {
    const audio = (window as Window & { timelinePlayed?: HTMLMediaElement[] }).timelinePlayed?.[position];
    return audio ? { paused: audio.paused, src: audio.getAttribute('src') } : null;
  }, index);

  await expect.poll(() => position(page)).toBeCloseTo(0, 1);
  await expect.poll(played).toBe(0);
  await page.keyboard.press('t');
  await expect.poll(() => position(page)).toBeGreaterThan(0.4);
  await expect.poll(played).toBe(1);
  await expect.poll(() => audioState(0).then(state => state?.paused)).toBe(false);
  await page.keyboard.press('t');
  await expect.poll(() => audioState(0).then(state => state?.paused)).toBe(true);

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => audioState(0)).toEqual({ paused: true, src: null });

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => position(page)).toBeCloseTo(0, 1);
  await page.keyboard.press('t');
  await expect.poll(() => position(page)).toBeGreaterThan(0.4);
  await expect.poll(played).toBe(2);
  const states = await page.evaluate(() => {
    const list = (window as Window & { timelinePlayed?: HTMLMediaElement[] }).timelinePlayed ?? [];
    return list.map(audio => ({ paused: audio.paused, src: audio.getAttribute('src') }));
  });
  expect(states).toHaveLength(2);
  expect(states[1].paused).toBe(false);
  expect(states[1].src).not.toBeNull();
  expect(states[0]).toEqual({ paused: true, src: null });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => audioState(1).then(state => state?.paused)).toBe(true);
  await expect(page.locator('#load-error')).toBeHidden();
});
