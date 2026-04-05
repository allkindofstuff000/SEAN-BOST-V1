module.exports = {
  apps: [
    {
      name: "seanbost-backend",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "2G",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "5000"
      }
    },
    {
      name: "seanbost-telegram",
      script: "src/telegram/controlProcessEntry.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PROCESS_ROLE: "api"
      }
    }
  ]
};
