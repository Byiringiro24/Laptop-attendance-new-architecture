/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },

  output: "standalone",

  // Allow any device on the VPN subnet (10.0.x.x) and local network to access
  // the Next.js dev server — needed for 100+ tablets each with their own VPN IP
  allowedDevOrigins: [
    "10.0.0.0/16",      // entire WireGuard VPN subnet
    "192.168.0.0/16",   // local network (any subnet)
    "172.16.0.0/12",    // Docker / other local subnets
    "localhost",
    "127.0.0.1",
  ],
};

module.exports = nextConfig;