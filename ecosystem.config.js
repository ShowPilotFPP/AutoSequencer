// PM2: `pm2 start ecosystem.config.js && pm2 save`
const path = require('path');
const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'autoseq',
      cwd: path.join(root, 'app'),
      script: 'server.js',
      env: {
        PORT: 3075,
        AUTOSEQ_WORKER_URL: 'http://127.0.0.1:5051',
        AUTOSEQ_DATA_DIR: path.join(root, 'data'),
      },
    },
    {
      name: 'autoseq-worker',
      cwd: path.join(root, 'worker'),
      script: path.join(root, 'worker', '.venv', 'bin', 'python'),
      args: '-m autoseq serve',
      interpreter: 'none',
      env: {
        AUTOSEQ_PORT: 5051,
        AUTOSEQ_DATA_DIR: path.join(root, 'data', 'analysis'),
        AUTOSEQ_RHUBARB_BIN: path.join(root, 'bin', 'rhubarb', 'rhubarb'),
        AUTOSEQ_FRAME_MS: 25,
        AUTOSEQ_KEEP_STEMS: 'vocals',   // vocals | all | none — see README
      },
      max_memory_restart: '12G',
      kill_timeout: 5000,
    },
  ],
};
