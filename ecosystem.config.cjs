module.exports = {
  apps: [
    {
      name: 'coin-trading',
      script: 'src/index.js',
      cwd: 'C:/COIN',
      interpreter: 'node',
      interpreter_args: '',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '1G',
      restart_delay: 5000,
      max_restarts: 10,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/coin-trading-error.log',
      out_file: 'logs/coin-trading-out.log',
      merge_logs: true,
    },
  ],
};
