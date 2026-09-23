module.exports = {
  apps: [
    {
      name: "seanbost-backend",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "6G",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "5000",
        // Single-box topology: run the worker engine IN-PROCESS (recovery loop
        // included) instead of delegating to a remote worker on :5001 that we
        // never launch. Without this, PROCESS_ROLE defaults to "api" in
        // production and no accounts would actually run.
        PROCESS_ROLE: "worker",
        // Each running account holds one persistent headless Chrome, so this is
        // effectively the max simultaneous browsers. ~20 fits comfortably on a
        // 15GB box; raise/lower to taste (memory is the constraint).
        MAX_CONCURRENCY: "20"
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
