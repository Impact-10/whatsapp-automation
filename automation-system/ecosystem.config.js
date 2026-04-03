module.exports = {
  apps: [
    {
      name: "pet-clinic-automation",
      script: "backend/app.js",
      interpreter: "D:\\work\\Message-Automation\\tools\\node20\\node-v20.20.1-win-x64\\node.exe",
      cwd: "D:\\work\\Message-Automation\\automation-system",
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
