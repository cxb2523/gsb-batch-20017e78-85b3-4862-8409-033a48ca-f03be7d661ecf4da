// A single export is defined entirely by the inputs captured here. Cloning the
// recipe and normalizing the numeric settings at click time is what keeps later
// control edits from leaking into an export that is already rendering.
const boundedSetting = (value, fallback, minimum, maximum) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
};

export const sanitizeFilename = (value) => String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'ability-fx';

export const exportName = (recipe) => `${sanitizeFilename(recipe?.name)}-${sanitizeFilename(recipe?.motif)}`;

const cloneRecipe = (recipe) => {
    try {
        return structuredClone(recipe);
    } catch {
        return JSON.parse(JSON.stringify(recipe));
    }
};

export const captureExportSnapshot = (recipe, options = {}) => {
    if (!recipe || typeof recipe !== 'object') {
        throw new TypeError('An export requires a recipe.');
    }

    return Object.freeze({
        recipe: cloneRecipe(recipe),
        size: Math.round(boundedSetting(options.size, 160, 128, 256)),
        frameCount: Math.round(boundedSetting(options.frameCount, 32, 24, 48)),
        fps: Math.round(boundedSetting(options.fps, 16, 12, 24))
    });
};
