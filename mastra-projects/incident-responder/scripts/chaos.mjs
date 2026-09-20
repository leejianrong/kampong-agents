// Real chaos injection against the real toy-service: `npm run chaos -- down`
// (or high_latency / high_errors / ok). Not a mock -- this actually flips
// the running container's behavior and its real /metrics output.
const mode = process.argv[2];
const validModes = ["ok", "down", "high_latency", "high_errors"];

if (!mode || !validModes.includes(mode)) {
  console.error(`Usage: npm run chaos -- <${validModes.join("|")}>`);
  process.exit(1);
}

const baseUrl = process.env.TOY_SERVICE_URL ?? "http://localhost:9100";
const response = await fetch(`${baseUrl}/chaos/${mode}`, { method: "POST" });
const body = await response.json();
console.log(body);
