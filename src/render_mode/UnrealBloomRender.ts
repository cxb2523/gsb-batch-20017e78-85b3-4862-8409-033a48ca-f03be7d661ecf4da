import { AddMaterial } from '../materials/AddMaterial';
import { UnrealBloomComposeMaterial } from '../materials/UnrealBloomComposeMaterial';
import { OScreen } from '../OScreen';
import { BaseRender } from '../render_mode/BaseRender';

import { HalfFloatType, LinearSRGBColorSpace, NearestFilter, RenderTarget, RGBAFormat, Texture, UnsignedByteType } from 'three';

import { CameraManager } from '../CameraManager';
import { Graphics } from '../Graphics';
import { GaussianBlurrer } from '../render_utilities/GaussianBlurrer';
import { SceneManager } from '../SceneManager';

class UnrealBloomRender extends BaseRender
{
  add_mat: AddMaterial;
  bloom_compose_mat: UnrealBloomComposeMaterial;
  blurrer: GaussianBlurrer;
  bloom_radius: number;
  luminosity_threshold: number;
  main_RT: RenderTarget;
  use_antialiasing: boolean;
  use_half_float: boolean;
  use_hight_luminosity_pass: boolean;
  use_rendering_size: boolean;

  constructor(use_antialiasing: boolean, use_half_float: boolean, use_hight_luminosity_pass: boolean, use_rendering_size = false)
  {
    super();

    this.use_antialiasing = use_antialiasing;
    this.use_half_float = use_half_float;
    this.use_hight_luminosity_pass = use_hight_luminosity_pass;
    this.use_rendering_size = use_rendering_size;

    // The materials are cheap and hold the tuning (strength, radius, tints), so they
    // live as long as the mode does. The targets and the blurrer are built in
    // on_enter() and freed in on_exit(), so a mode switch never keeps GPU textures.
    this.add_mat = new AddMaterial(use_half_float);
    this.bloom_compose_mat = new UnrealBloomComposeMaterial(5, use_half_float);
    this.main_RT = undefined;
    this.blurrer = undefined;

    // Settings reach the blurrer whenever it exists. Keeping the last value here lets
    // the setters work before the first on_enter() and survive an exit and re-entry,
    // so a reused mode comes back with the same look. These mirror GaussianBlurrer's
    // own defaults (radius 1, threshold 0.23).
    this.bloom_radius = 1;
    this.luminosity_threshold = 0.23;
  }

  on_enter()
  {
    // A second on_enter() without an on_exit() must not leak the first cycle.
    this.on_exit();

    this.main_RT = this.__create_main_RT();
    this.blurrer = new GaussianBlurrer(this.use_half_float);

    this.blurrer.set_radius(this.bloom_radius);
    this.blurrer.set_luminosity_threshold(this.luminosity_threshold);

    this.bloom_compose_mat.set_blur_texture_0(this.blurrer.renderTargetsVertical[0].texture);
    this.bloom_compose_mat.set_blur_texture_1(this.blurrer.renderTargetsVertical[1].texture);
    this.bloom_compose_mat.set_blur_texture_2(this.blurrer.renderTargetsVertical[2].texture);
    this.bloom_compose_mat.set_blur_texture_3(this.blurrer.renderTargetsVertical[3].texture);
    this.bloom_compose_mat.set_blur_texture_4(this.blurrer.renderTargetsVertical[4].texture);

    this.add_mat.set_add_texture(this.blurrer.renderTargetsHorizontal[0].texture);
  }

  // Frees what on_enter() built: the scene target, the blurrer and the blurrer's own
  // materials and targets. Calling it again, or before on_enter(), does nothing.
  on_exit()
  {
    if (this.main_RT === undefined && this.blurrer === undefined)
    {
      return;
    }

    if (this.blurrer !== undefined)
    {
      this.__unbind_textures();
      this.blurrer.dispose();
      this.blurrer = undefined;
    }

    if (this.main_RT !== undefined)
    {
      this.main_RT.dispose();
      this.main_RT = undefined;
    }
  }

  render()
  {
    this.__check_RT_size();

    Graphics.clear(this.main_RT, CameraManager.current, true, false);
    Graphics.render(SceneManager.current, CameraManager.current, this.main_RT);

    // // // BLUR
    this.blurrer.blur(this.main_RT, this.use_hight_luminosity_pass);

    // // Blur compose
    Graphics.material_pass(this.bloom_compose_mat, this.blurrer.renderTargetsHorizontal[0]);

    // // Additive blend
    // Graphics.clear(undefined, CameraManager.current, true, false);
    // Graphics.render(SceneManager.current, CameraManager.current);
    Graphics.blit(this.main_RT, undefined, this.add_mat);
  }

  set_bloom_strength(val: number)
  {
    this.bloom_compose_mat.set_bloom_strength(val);
  }

  set_bloom_radius(val: number)
  {
    // this.bloom_compose_mat.set_bloom_radius(val);
    this.bloom_radius = val;

    if (this.blurrer !== undefined)
    {
      this.blurrer.set_radius(val);
    }
  }

  set_luminosity_threshold(value: number)
  {
    this.luminosity_threshold = value;

    if (this.blurrer !== undefined)
    {
      this.blurrer.set_luminosity_threshold(value);
    }
  }

  set_tint_color_0(col_string: string)
  {
    this.bloom_compose_mat.set_tint_color_0(col_string);
  }

  set_tint_color_1(col_string: string)
  {
    this.bloom_compose_mat.set_tint_color_1(col_string);
  }

  set_tint_color_2(col_string: string)
  {
    this.bloom_compose_mat.set_tint_color_2(col_string);
  }

  set_tint_color_3(col_string: string)
  {
    this.bloom_compose_mat.set_tint_color_3(col_string);
  }

  set_tint_color_4(col_string: string)
  {
    this.bloom_compose_mat.set_tint_color_4(col_string);
  }

  __check_RT_size()
  {
    const width = this.use_rendering_size ? OScreen.render_width : OScreen.width;
    const height = this.use_rendering_size ? OScreen.render_height : OScreen.height;
    if (this.main_RT.width !== width || this.main_RT.height !== height)
    {
      this.main_RT.setSize(width, height);
    }
  }

  __create_main_RT(): RenderTarget
  {
    const rt_settings = {
      // WebGPU only supports 1 or 4 samples. Higher counts render nothing on both backends.
      samples: this.use_antialiasing ? 4 : 1,
      type: this.use_half_float ? HalfFloatType : UnsignedByteType,
      format: RGBAFormat,
      colorSpace: LinearSRGBColorSpace,
      minFilter: NearestFilter,
      magFilter: NearestFilter
    };
    const main_RT = new RenderTarget(1, 1, rt_settings);

    main_RT.texture.colorSpace = LinearSRGBColorSpace;
    main_RT.texture.minFilter = NearestFilter;
    main_RT.texture.magFilter = NearestFilter;

    return main_RT;
  }

  // Points the compose and add materials at an empty texture, so nothing keeps sampling
  // the blurrer's targets once on_exit() disposes them. on_enter() rebinds the new ones.
  __unbind_textures()
  {
    const empty_texture = new Texture();

    this.bloom_compose_mat.set_blur_texture_0(empty_texture);
    this.bloom_compose_mat.set_blur_texture_1(empty_texture);
    this.bloom_compose_mat.set_blur_texture_2(empty_texture);
    this.bloom_compose_mat.set_blur_texture_3(empty_texture);
    this.bloom_compose_mat.set_blur_texture_4(empty_texture);

    this.add_mat.set_add_texture(empty_texture);
  }
}

export { UnrealBloomRender };
