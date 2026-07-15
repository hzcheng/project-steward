'use strict';

const path = require('path');

module.exports = {
    target: 'node',
    entry: path.resolve(__dirname, 'src', 'extension.ts'),
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2',
    },
    devtool: false,
    externals: { vscode: 'commonjs vscode' },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
        rules: [{
            test: /\.ts$/,
            exclude: /node_modules/,
            use: [{
                loader: 'ts-loader',
                options: { configFile: path.resolve(__dirname, 'tsconfig.json') },
            }],
        }],
    },
};
