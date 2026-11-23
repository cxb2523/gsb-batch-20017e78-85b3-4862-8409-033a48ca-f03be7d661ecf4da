const path = require('path');

// Builds the standalone demo pages in `samples/rebuild-demo`.
module.exports = {
    entry: {
        demo: './samples/rebuild-demo/demo.ts',
        selfcheck: './samples/rebuild-demo/selfcheck.ts',
    },
    mode: 'development',
    devtool: 'inline-source-map',
    output: {
        filename: '[name].js',
        path: path.resolve(__dirname, 'samples', 'rebuild-demo'),
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: {
                    loader: 'ts-loader',
                    options: {
                        configFile: path.resolve(
                            __dirname,
                            'tsconfig.demo.json'
                        ),
                    },
                },
                exclude: /node_modules/,
            },
        ],
    },
};
