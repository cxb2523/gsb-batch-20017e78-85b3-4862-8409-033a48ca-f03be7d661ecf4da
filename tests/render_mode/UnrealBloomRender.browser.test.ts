import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Mesh, PlaneGeometry } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';

import { Graphics } from '../../src/Graphics';
import { SceneManager } from '../../src/SceneManager';
import { BaseRender } from '../../src/render_mode/BaseRender';
import { NormalRender } from '../../src/render_mode/NormalRender';
import { UnrealBloomRender } from '../../src/render_mode/UnrealBloomRender';
import { AbstractScene } from '../../src/scenes/AbstractScene';
import { BACKENDS, create_harness, type Harness, type Pixels, SIZE } from '../helpers/webgpu_harness';

// An 8x8 white quad spanning pixels 12..20 on both axes, counted from the top left corner.
const QUAD_CENTER = { x: 16, y: 16 };
// 2px outside the quad edge. One probe per blur pass direction.
const HORIZONTAL_GLOW_PROBE = { x: 22, y: 16 };
const VERTICAL_GLOW_PROBE = { x: 16, y: 22 };
// Where the quad and its near glow would land if the image were flipped vertically.
const MIRRORED_PROBE = { x: 16, y: 48 };
const MIRRORED_GLOW_PROBE = { x: 22, y: 48 };

const CONFIGURATIONS = [
  { name: 'default', antialiasing: false, half_float: false, high_pass: false },
  { name: 'antialiasing', antialiasing: true, half_float: false, high_pass: false },
  { name: 'half float', antialiasing: false, half_float: true, high_pass: false },
  { name: 'luminosity high pass', antialiasing: false, half_float: false, high_pass: true },
  { name: 'everything enabled', antialiasing: true, half_float: true, high_pass: true }
];

function build_scene(): AbstractScene
{
  const scene = new AbstractScene({ name: 'unreal_bloom_test', compilators: {} });
  const quad = new Mesh(new PlaneGeometry(8, 8), new MeshBasicNodeMaterial({ color: 0xffffff }));

  quad.position.set(QUAD_CENTER.x - SIZE / 2, SIZE / 2 - QUAD_CENTER.y, 0);
  scene.add(quad);

  return scene;
}

function create_bloom({ antialiasing = false, half_float = false, high_pass = false } = {})
{
  return new UnrealBloomRender(antialiasing, half_float, high_pass);
}

for (const backend of BACKENDS)
{
  describe(`UnrealBloomRender on WebGPURenderer (${backend.name} backend)`, () =>
  {
    let harness: Harness;

    beforeEach(async() =>
    {
      harness = await create_harness(backend);
      SceneManager.current = build_scene();
    });

    afterEach(() =>
    {
      harness.dispose();
    });

    function render_with(render_mode: BaseRender, configure?: () => void): Pixels
    {
      Graphics.set_state(render_mode);
      configure?.();
      render_mode.render();
      render_mode.render();

      return harness.read_canvas();
    }

    it(`runs on the ${backend.name} backend`, () =>
    {
      expect(harness.uses_backend()).toBe(true);
    });

    it.each(CONFIGURATIONS)('renders the scene without errors ($name)', (configuration) =>
    {
      const pixels = render_with(create_bloom(configuration));

      expect(harness.reported_errors).toEqual([]);
      expect(pixels.luminance(QUAD_CENTER)).toBeGreaterThan(200);
    });

    it('keeps the scene and its glow in the right orientation', () =>
    {
      const pixels = render_with(create_bloom());

      expect(pixels.luminance(QUAD_CENTER)).toBeGreaterThan(200);
      expect(pixels.luminance(MIRRORED_PROBE)).toBeLessThan(pixels.luminance(QUAD_CENTER) / 2);
      expect(pixels.luminance(HORIZONTAL_GLOW_PROBE)).toBeGreaterThan(pixels.luminance(MIRRORED_GLOW_PROBE) + 20);
    });

    it('spreads a glow around bright pixels, in both blur directions, that plain rendering does not', () =>
    {
      const plain = render_with(new NormalRender());
      expect(plain.luminance(HORIZONTAL_GLOW_PROBE)).toBeLessThan(5);
      expect(plain.luminance(VERTICAL_GLOW_PROBE)).toBeLessThan(5);

      const bloomed = render_with(create_bloom());
      expect(bloomed.luminance(HORIZONTAL_GLOW_PROBE)).toBeGreaterThan(20);
      expect(bloomed.luminance(VERTICAL_GLOW_PROBE)).toBeGreaterThan(20);
    });

    it('adds no glow at zero bloom strength', () =>
    {
      const pixels = render_with(create_bloom(), () =>
      {
        (Graphics.current_render_mode as UnrealBloomRender).set_bloom_strength(0);
      });

      expect(pixels.luminance(QUAD_CENTER)).toBeGreaterThan(200);
      expect(pixels.luminance(HORIZONTAL_GLOW_PROBE)).toBeLessThan(5);
    });

    it('only blooms pixels above the luminosity threshold when the high pass is enabled', () =>
    {
      const below = render_with(create_bloom({ high_pass: true }), () =>
      {
        (Graphics.current_render_mode as UnrealBloomRender).set_luminosity_threshold(1.5);
      });
      expect(below.luminance(QUAD_CENTER)).toBeGreaterThan(200);
      expect(below.luminance(HORIZONTAL_GLOW_PROBE)).toBeLessThan(5);

      const above = render_with(create_bloom({ high_pass: true }), () =>
      {
        (Graphics.current_render_mode as UnrealBloomRender).set_luminosity_threshold(0.5);
      });
      expect(above.luminance(HORIZONTAL_GLOW_PROBE)).toBeGreaterThan(20);
    });

    it('tints the glow with the mip tint colors', () =>
    {
      const pixels = render_with(create_bloom(), () =>
      {
        const bloom = Graphics.current_render_mode as UnrealBloomRender;

        bloom.set_tint_color_0('#ff0000');
        bloom.set_tint_color_1('#ff0000');
        bloom.set_tint_color_2('#ff0000');
        bloom.set_tint_color_3('#ff0000');
        bloom.set_tint_color_4('#ff0000');
      });

      const glow = pixels.rgb(HORIZONTAL_GLOW_PROBE);
      expect(glow.r).toBeGreaterThan(20);
      expect(glow.g).toBeLessThan(5);
      expect(glow.b).toBeLessThan(5);
    });

    // A mode is often reused: leaving it frees its targets and blurrer, and entering it
    // again must rebuild them, rebind the textures and look like the first run.
    it('renders identically the second time it is entered', () =>
    {
      const bloom = create_bloom();
      const settings = (mode: UnrealBloomRender) =>
      {
        mode.set_bloom_strength(1.2);
        mode.set_bloom_radius(1.5);
        mode.set_tint_color_0('#ff8800');
      };

      Graphics.set_state(bloom);
      settings(bloom);
      bloom.render();
      bloom.render();
      const first = harness.read_canvas();

      Graphics.set_state(new NormalRender());

      Graphics.set_state(bloom);
      bloom.render();
      bloom.render();
      const second = harness.read_canvas();

      expect(second.luminance(QUAD_CENTER)).toBe(first.luminance(QUAD_CENTER));
      expect(second.luminance(HORIZONTAL_GLOW_PROBE)).toBe(first.luminance(HORIZONTAL_GLOW_PROBE));
      expect(second.luminance(VERTICAL_GLOW_PROBE)).toBe(first.luminance(VERTICAL_GLOW_PROBE));
      expect(second.rgb(HORIZONTAL_GLOW_PROBE)).toEqual(first.rgb(HORIZONTAL_GLOW_PROBE));
      expect(first.luminance(HORIZONTAL_GLOW_PROBE)).toBeGreaterThan(20);
      expect(harness.reported_errors).toEqual([]);
    });

    // Settings applied while the mode was first active must survive the exit, so the
    // re-entered blurrer is not silently rebuilt at its default look.
    it('keeps its tuning across an exit and re-entry', () =>
    {
      const bloom = create_bloom({ high_pass: true });

      Graphics.set_state(bloom);
      bloom.set_luminosity_threshold(1.5);
      bloom.render();
      bloom.render();
      const first = harness.read_canvas();
      expect(first.luminance(HORIZONTAL_GLOW_PROBE)).toBeLessThan(5);

      Graphics.set_state(new NormalRender());
      Graphics.set_state(bloom);
      bloom.render();
      bloom.render();
      const second = harness.read_canvas();

      expect(second.luminance(HORIZONTAL_GLOW_PROBE)).toBeLessThan(5);
      expect(second.luminance(QUAD_CENTER)).toBe(first.luminance(QUAD_CENTER));
      expect(harness.reported_errors).toEqual([]);
    });

    // The dev bridge builds a new mode on every switch, so leaving one must free every
    // texture it built on entry, or GPU memory grows with each switch.
    it('frees its GPU textures when left', () =>
    {
      render_with(new NormalRender());
      const textures_before = harness.renderer.info.memory.textures;

      for (let i = 0; i < 3; i++)
      {
        render_with(create_bloom({ antialiasing: true, half_float: true, high_pass: true }));
        render_with(new NormalRender());
      }

      expect(harness.renderer.info.memory.textures).toBe(textures_before);
      expect(harness.reported_errors).toEqual([]);
    });

    it('rebuilds its resources and rebinds every blur texture on re-entry', () =>
    {
      const bloom = create_bloom();

      Graphics.set_state(bloom);
      const first_main_RT = bloom.main_RT;
      const first_blurrer = bloom.blurrer;
      const first_blur_textures = [0, 1, 2, 3, 4].map((i) =>
        bloom.bloom_compose_mat.uniforms[`blurTexture${i + 1}`].value);
      const first_add_texture = bloom.add_mat.uniforms._SecondTex.value;

      Graphics.set_state(new NormalRender());

      // Leaving frees every resource and stops sampling the disposed textures.
      expect(bloom.main_RT).toBeUndefined();
      expect(bloom.blurrer).toBeUndefined();
      for (let i = 0; i < 5; i++)
      {
        expect(bloom.bloom_compose_mat.uniforms[`blurTexture${i + 1}`].value).not.toBe(first_blur_textures[i]);
      }
      expect(bloom.add_mat.uniforms._SecondTex.value).not.toBe(first_add_texture);

      Graphics.set_state(bloom);

      expect(bloom.main_RT).not.toBe(first_main_RT);
      expect(bloom.blurrer).not.toBe(first_blurrer);
      for (let i = 0; i < 5; i++)
      {
        expect(bloom.bloom_compose_mat.uniforms[`blurTexture${i + 1}`].value)
          .toBe(bloom.blurrer.renderTargetsVertical[i].texture);
      }
      expect(bloom.add_mat.uniforms._SecondTex.value).toBe(bloom.blurrer.renderTargetsHorizontal[0].texture);
      expect(harness.reported_errors).toEqual([]);
    });

    it('disposes its main target, blurrer and blurrer resources when left', () =>
    {
      const bloom = create_bloom();

      Graphics.set_state(bloom);

      const disposals: string[] = [];
      bloom.main_RT.addEventListener('dispose', () => disposals.push('main_RT'));
      bloom.blurrer.renderTargetBright.addEventListener('dispose', () => disposals.push('renderTargetBright'));
      bloom.blurrer.renderTargetsVertical[0].addEventListener('dispose', () => disposals.push('vertical_mip'));
      bloom.blurrer.renderTargetsHorizontal[0].addEventListener('dispose', () => disposals.push('horizontal_mip'));
      bloom.blurrer.separableBlurMaterials[0].addEventListener('dispose', () => disposals.push('blur_material'));
      bloom.blurrer.luminosity_high_pass_mat.addEventListener('dispose', () => disposals.push('high_pass'));

      Graphics.set_state(new NormalRender());

      expect(disposals).toEqual(expect.arrayContaining([
        'main_RT', 'renderTargetBright', 'vertical_mip', 'horizontal_mip', 'blur_material', 'high_pass'
      ]));
      expect(harness.reported_errors).toEqual([]);
    });

    it('leaving twice in a row does not throw or dispose again', () =>
    {
      const bloom = create_bloom();

      Graphics.set_state(bloom);

      let main_disposals = 0;
      bloom.main_RT.addEventListener('dispose', () => main_disposals++);

      bloom.on_exit();
      expect(() => bloom.on_exit()).not.toThrow();
      expect(main_disposals).toBe(1);
      expect(harness.reported_errors).toEqual([]);
    });

    it('leaving before entering does not throw', () =>
    {
      expect(() => create_bloom().on_exit()).not.toThrow();
      expect(() => create_bloom({ antialiasing: true, half_float: true, high_pass: true }).on_exit()).not.toThrow();
      expect(harness.reported_errors).toEqual([]);
    });

    it('keeps the bloom controls working before the first entry', () =>
    {
      const bloom = create_bloom({ high_pass: true });

      // No blurrer exists yet; the setters must not throw and must reach the rebuilt one.
      expect(() => bloom.set_bloom_radius(2)).not.toThrow();
      expect(() => bloom.set_luminosity_threshold(1.5)).not.toThrow();
      expect(() => bloom.set_bloom_strength(0.5)).not.toThrow();

      Graphics.set_state(bloom);
      bloom.render();
      const pixels = harness.read_canvas();

      expect(bloom.blurrer.separableBlurMaterials.every((mat) => mat.uniforms.radius.value === 2)).toBe(true);
      expect(bloom.blurrer.luminosity_high_pass_mat.uniforms.luminosityThreshold.value).toBe(1.5);
      expect(pixels.luminance(HORIZONTAL_GLOW_PROBE)).toBeLessThan(5);
      expect(harness.reported_errors).toEqual([]);
    });
  });
}
