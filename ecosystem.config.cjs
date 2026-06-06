// pm2 process definitions: the web app + the Cloudflare tunnel that gives it
// a public https URL. Both auto-restart and survive reboots (with `pm2 save`).
module.exports = {
  apps: [
    {
      name: "archive-recover",
      script: "server.js",
      cwd: "/home/khaled/projects/archive-recover",
      env: { PORT: "3000" },
    },
    {
      name: "archive-tunnel",
      script: "/usr/local/bin/cloudflared",
      interpreter: "none",
      args: "tunnel --url http://localhost:3000 --no-autoupdate",
      cwd: "/home/khaled/projects/archive-recover",
    },
  ],
};
