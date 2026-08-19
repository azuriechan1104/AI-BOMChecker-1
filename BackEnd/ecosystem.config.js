module.exports = {
  apps: [
    {
      name: 'BOM',
      script: 'server.js',
      cwd: __dirname,
      watch: true,
      ignore_watch: ['node_modules', 'server_test.log', 'server_test_err.log'],
    },
  ],
};
