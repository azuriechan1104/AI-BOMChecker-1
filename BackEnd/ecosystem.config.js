module.exports = {
  apps: [
    {
      name: 'BOM',
      script: 'server.js',
      cwd: __dirname,
      watch: true,
      ignore_watch: ['node_modules', 'server_test.log', 'server_test_err.log'],
      // Local dev port. 3000 collides with the wiwynn-rack-monitor frontend
      // dev server, which also hardcodes 3000; keep this instance off it.
      // Remote deploys pass PORT explicitly (see tools/deploy_ai_bom_online.py)
      // and don't use this file, so this only affects local `pm2 start`.
      env: { PORT: 3100 },
    },
  ],
};
