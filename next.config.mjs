/** @type {import('next').NextConfig} */
const nextConfig = {
  // CRITICAL for Docker: 'standalone' makes `next build` emit a minimal
  // self-contained server (server.js + only the node_modules it actually
  // needs) into .next/standalone. Without this, the runner image would
  // need the full node_modules tree (~hundreds of MB).
  output: 'standalone',

  // The API base URL is read at RUNTIME in server components via
  // process.env, so it is passed with `docker run -e` / k8s env —
  // never baked into the image at build time.
  env: {},
};

export default nextConfig;
