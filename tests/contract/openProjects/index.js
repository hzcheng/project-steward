'use strict';

const fs = require('node:fs');
const path = require('node:path');

fs.readdirSync(__dirname, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => entry.name)
    .sort()
    .forEach(fileName => require(path.join(__dirname, fileName)));
