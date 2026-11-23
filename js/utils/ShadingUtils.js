import { MeshRendererAdapter } from '../geometry/MeshRendererAdapter.js';
import { SharpUtils } from './SharpUtils.js';

export const SHADING_MODES = ['flat', 'smooth', 'auto'];
export const DEFAULT_SHADING_MODE = 'flat';
export const DEFAULT_SHADING_ANGLE = 60;

export class ShadingUtils {
  static getShading(object) {
    return this.normalize({
      mode: object.userData.shading,
      angle: object.userData.shadingAngle,
    });
  }

  static normalize({ mode, angle } = {}) {
    return {
      mode: SHADING_MODES.includes(mode) ? mode : DEFAULT_SHADING_MODE,
      angle: Number.isFinite(angle) ? Math.min(Math.max(angle, 0), 180) : DEFAULT_SHADING_ANGLE,
    };
  }

  static setShading(object, patch) {
    const prev = this.getShading(object);
    const state = this.normalize({ ...prev, ...patch });

    object.userData.shading = state.mode;
    object.userData.shadingAngle = state.angle;

    // Angle-only changes in auto mode keep the same buffers and slot maps;
    // re-split smoothing groups in place instead of rebuilding geometry.
    if (
      state.mode === 'auto' &&
      prev.mode === 'auto' &&
      state.angle !== prev.angle &&
      object.userData.meshData &&
      object.userData.renderBuffer &&
      object.geometry
    ) {
      MeshRendererAdapter.updateNormalAngle(
        object.userData.meshData,
        object.userData.renderBuffer,
        object.geometry,
        state.angle
      );
      return state;
    }

    this.rebuildShading(object);
    return state;
  }

  static rebuildShading(object) {
    const meshData = object.userData.meshData;
    if (!meshData) return;

    const { mode, angle } = this.getShading(object);
    const sharps = SharpUtils.getSharpIds(object);

    const { geometry, renderBuffer } = MeshRendererAdapter.toBufferGeometry(meshData, { mode, angle, sharps });

    object.geometry.dispose();
    object.geometry = geometry;
    object.userData.renderBuffer = renderBuffer;
  }
}