// Babel configuration used by Jest (babel-jest). The webpack build keeps its
// own inline loader options in webpack.config.js and does not read this file.
module.exports = {
    presets: [
        [ '@babel/preset-env', { targets: { node: 'current' } } ],
        [ '@babel/preset-react', { runtime: 'automatic' } ],
    ],
};
