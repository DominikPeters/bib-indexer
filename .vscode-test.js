const path = require('path');
const { defineConfig } = require('@vscode/test-cli');

module.exports = defineConfig({
  files: 'out/test/**/*.test.js',
  workspaceFolder: path.join(__dirname, 'src', 'test', 'fixtures'),
  mocha: {
    timeout: 10000,
  },
});
