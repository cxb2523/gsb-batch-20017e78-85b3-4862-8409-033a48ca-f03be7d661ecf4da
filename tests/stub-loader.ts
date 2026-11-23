// ==============================================
// ESM resolve/load 钩子：将 three 及其它重型依赖解析到内存虚拟打桩模块，
// 仅暴露被测代码实际用到的最小接口，无需 npm install 即可在 Node 下运行测试。
// ==============================================

const STUB_URL = 'data:text/javascript,';

/** 需要打桩的裸包名（含子路径前缀匹配） */
const STUBBED_PREFIXES = ['three', 'xz-decompress', 'fflate', '@oneidentity', 'nipplejs', '@tweenjs', '@dimforge', '@gotoeasy'];

// three 中作为值使用的常量/枚举（其余命名导出按类/函数打桩）
const THREE_CONSTANTS = new Set([
    'AdditiveBlending',
    'DoubleSide',
    'DynamicDrawUsage',
    'NearestFilter',
    'NormalBlending',
    'RGBAIntegerFormat',
    'SRGBColorSpace',
    'UnsignedByteType',
    'UnsignedIntType',
]);

// 仓库内实际从 'three' 引用的全部命名导出
const THREE_EXPORTS = [
    'AdditiveBlending', 'AmbientLight', 'AnimationAction', 'AnimationClip', 'AnimationMixer', 'Audio', 'AudioListener',
    'AudioLoader', 'BoxGeometry', 'BufferAttribute', 'BufferGeometry', 'Camera', 'CanvasTexture', 'CatmullRomCurve3',
    'CircleGeometry', 'Clock', 'Color', 'ColorRepresentation', 'CylinderGeometry', 'DataArrayTexture', 'DataTexture',
    'DirectionalLight', 'DoubleSide', 'DynamicDrawUsage', 'Euler', 'EventDispatcher', 'Float32BufferAttribute',
    'FogExp2', 'Frustum', 'Group', 'InstancedBufferAttribute', 'InstancedBufferGeometry', 'Intersection',
    'LineBasicMaterial', 'LineSegments', 'Material', 'MathUtils', 'Matrix4', 'Mesh', 'MeshBasicMaterial',
    'MeshStandardMaterial', 'NearestFilter', 'NormalBlending', 'Object3D', 'OrthographicCamera', 'PerspectiveCamera',
    'Plane', 'PlaneGeometry', 'Points', 'PointsMaterial', 'Quaternion', 'RGBAIntegerFormat', 'Raycaster', 'Renderer',
    'RingGeometry', 'SRGBColorSpace', 'Scene', 'ShaderChunk', 'ShaderMaterial', 'Shape', 'ShapeGeometry',
    'SphereGeometry', 'Texture', 'TextureLoader', 'UnsignedByteType', 'UnsignedIntType', 'Vector2', 'Vector3',
    'Vector4', 'WebGLRenderTarget', 'WebGLRenderer',
];

function buildThreeStub(): string {
    const lines: string[] = [];
    lines.push(`
// 可控假 DataArrayTexture：记录写入、层更新并允许手动触发 onUpdate
export class DataArrayTexture {
    constructor(data, width, height, depth) {
        this.image = { data, width, height, depth };
        this.needsUpdate = false;
        this.onUpdate = null;
        this.layerUpdates = [];
        this.writeCount = 0;
        this.disposed = false;
        this.lastWritten = null;
    }
    addLayerUpdate(layer) {
        if (this.disposed) throw new Error('texture already disposed: addLayerUpdate');
        this.layerUpdates.push(layer);
    }
    flushUpdate() {
        if (this.onUpdate) {
            const fn = this.onUpdate;
            this.onUpdate = null;
            fn();
        }
    }
    dispose() {
        this.disposed = true;
    }
}
export class DataTexture {
    constructor(data, width, height) {
        this.image = { data, width, height };
        this.needsUpdate = false;
        this.onUpdate = null;
        this.disposed = false;
    }
    dispose() { this.disposed = true; }
}
// 常用容器/数学对象的最小可用实现
export class Vector2 {
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    set(x, y) { this.x = x; this.y = y; return this; }
    clone() { return new Vector2(this.x, this.y); }
}
export class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    toArray() { return [this.x, this.y, this.z]; }
    fromArray(a) { this.x = a[0]; this.y = a[1]; this.z = a[2]; return this; }
    getWorldDirection() { return new Vector3(); }
    distanceTo() { return 0; }
}
export class Vector4 {
    constructor(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w; }
    set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
}
export class Matrix4 {
    constructor() { this.elements = new Array(16).fill(0); }
    clone() { return new Matrix4(); }
    multiply() { return this; }
    multiplyScalar() { return this; }
    toArray() { return this.elements.slice(); }
    fromArray(a) { this.elements = a.slice(); return this; }
}
export class Quaternion { set() { return this; } clone() { return new Quaternion(); } }
export class Euler { set() { return this; } }
export class Color { set() { return this; } getHex() { return 0; } }
export class ShaderChunk {}
export const MathUtils = { clamp: (v, a, b) => Math.min(b, Math.max(a, v)) };
`);
    for (const name of THREE_EXPORTS) {
        if (
            [
                'DataArrayTexture', 'DataTexture', 'Vector2', 'Vector3', 'Vector4', 'Matrix4', 'Quaternion',
                'Euler', 'Color', 'ShaderChunk', 'MathUtils',
            ].includes(name)
        ) {
            continue; // 已给出专用实现
        }
        if (THREE_CONSTANTS.has(name)) {
            lines.push(`export const ${name} = '${name}';`);
        } else {
            lines.push(`export class ${name} { constructor() {} }`);
        }
    }
    return lines.join('\n');
}

// three 子路径（examples/addons/src）命名导出打桩，覆盖仓库内实际引用
const threeAddonStub = `
class _Stub { constructor() {} }
export class OrbitControls extends _Stub {}
export class MapControls extends _Stub {}
export class GLTFLoader extends _Stub {}
export class DRACOLoader extends _Stub {}
export class OBJLoader extends _Stub {}
export class PLYLoader extends _Stub {}
export class CSS2DObject extends _Stub {}
export class CSS2DRenderer extends _Stub {}
export class CSS3DObject extends _Stub {}
export class CSS3DSprite extends _Stub {}
export class CSS3DRenderer extends _Stub {}
export class Line2 extends _Stub {}
export class LineGeometry extends _Stub {}
export class LineMaterial extends _Stub {}
export function hashString() { return 0; }
`;

// 其它裸包打桩：覆盖仓库内实际用到的命名导出，默认/命名空间导入走 default
const genericStub = `
export class XzReadableStream {}
export class Tween { constructor() {} update() {} stop() {} }
export const Easing = {};
export function unzipSync() { return {}; }
export function ZstdInit() { return Promise.resolve({}); }
export default {};
`;
const threeStub = buildThreeStub();

/** 提取一个 TS 模块的运行期命名导出（class/enum/function/const/let/var），interface/type 不计 */
function collectRuntimeExports(source: string): Set<string> {
    const names = new Set<string>();
    const re = /export\s+(?:default\s+)?(?:abstract\s+|async\s+)*(?:class|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) names.add(m[1]);
    // export { Foo, Bar }
    const reList = /export\s*\{([^}]*)\}/g;
    while ((m = reList.exec(source))) {
        m[1]
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .forEach(s => names.add(s.split(/\s+as\s+/)[1]?.trim() || s));
    }
    return names;
}

const sourceCache = new Map<string, string>();
const runtimeExportCache = new Map<string, Set<string>>();

/**
 * 将无法在目标模块找到运行期导出的命名导入改写为本地空绑定
 * （对应 interface/type 导入，transform 阶段类型被擦除，运行时无需真实绑定）。
 */
function neutralizeTypeOnlyImports(source: string, resolveUrl: (spec: string) => string | undefined): string {
    let out = source.replace(/^\s*import\s+type\s+[^;]+;?\s*$/gm, '');
    out = out.replace(/import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"];?/g, (m, rawNames: string, spec: string) => {
        const targetUrl = resolveUrl(spec);
        if (!targetUrl || !targetUrl.startsWith('file:')) return m;
        const runtimeExports = runtimeExportCache.get(targetUrl);
        if (!runtimeExports) return m;
        const kept: string[] = [];
        const neutralized: string[] = [];
        rawNames
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .forEach(item => {
                const local = item.split(/\s+as\s+/)[1]?.trim() || item.trim();
                const imported = item.split(/\s+as\s+/)[0].trim();
                if (runtimeExports.has(imported)) {
                    kept.push(item);
                } else {
                    neutralized.push(local);
                }
            });
        const parts = neutralized.map(n => `const ${n} = undefined;`);
        if (kept.length) parts.unshift(`import { ${kept.join(', ')} } from '${spec}';`);
        return parts.join(' ');
    });
    return out;
}

export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'three' || specifier.startsWith('three/')) {
        return { url: STUB_URL + encodeURIComponent(specifier), shortCircuit: true, format: 'module' };
    }
    const bare = STUBBED_PREFIXES.some(p => specifier === p || specifier.startsWith(p + '/'));
    if (bare) {
        return { url: STUB_URL + encodeURIComponent(specifier), shortCircuit: true, format: 'module' };
    }
    // 项目内部使用无扩展名相对导入（打包器风格），Node 下补 .ts
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]s$/.test(specifier)) {
        try {
            return await nextResolve(specifier + '.ts', context);
        } catch {
            // 落到默认解析
        }
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    return await loadInner(url, context, nextLoad);
}

async function loadInner(url, context, nextLoad) {
    if (url.startsWith(STUB_URL)) {
        const specifier = decodeURIComponent(url.slice(STUB_URL.length));
        let code: string;
        if (specifier === 'three') code = threeStub;
        else if (specifier.startsWith('three/')) code = threeAddonStub;
        else code = genericStub;
        return { format: 'module', source: code, shortCircuit: true };
    }
    if (!url.startsWith('file:') || !/\.ts$/.test(url)) {
        return nextLoad(url, context);
    }

    // 预取所有项目模块源码，建立运行期导出索引（含被依赖模块，供导入改写判定）
    const loaded = await nextLoad(url, context);
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
    sourceCache.set(url, source);
    runtimeExportCache.set(url, collectRuntimeExports(source));

    const parentUrl = context.parentURL || url;
    const resolveUrl = (spec: string): string | undefined => {
        try {
            const resolved = new URL(spec, parentUrl);
            if (!/\.ts$/.test(resolved.pathname)) resolved.pathname += '.ts';
            return resolved.href;
        } catch {
            return undefined;
        }
    };

    // 预扫描本模块的相对依赖，确保它们的运行期导出也已入索引
    const importRe = /from\s+['"](\.[^'"]+)['"]/g;
    let im: RegExpExecArray | null;
    while ((im = importRe.exec(source))) {
        const depUrl = resolveUrl(im[1]);
        if (depUrl && depUrl.startsWith('file:') && !sourceCache.has(depUrl)) {
            try {
                const depLoaded = await nextLoad(depUrl, {});
                const depSource =
                    typeof depLoaded.source === 'string' ? depLoaded.source : Buffer.from(depLoaded.source).toString('utf8');
                sourceCache.set(depUrl, depSource);
                runtimeExportCache.set(depUrl, collectRuntimeExports(depSource));
            } catch {
                /* 依赖无法预取时交给默认解析报错 */
            }
        }
    }

    // 仅当模块本身声明了 interface/type 且没有任何运行期导出时，才虚拟为空模块；
    // 普通脚本（无导出的入口/测试文件）不能清空，否则模块体不会执行。
    const hasTypeDeclarations = /export\s+(?:interface|type)\s+/.test(source);
    if (hasTypeDeclarations && runtimeExportCache.get(url)!.size === 0) {
        return { format: 'module', source: 'export {};', shortCircuit: true };
    }
    // 保留原始 module-typescript 格式，交回 Node 的 transform-types 管线完成 TS 转译
    const finalSource = neutralizeTypeOnlyImports(source, resolveUrl);
    return { ...loaded, source: finalSource };
}
