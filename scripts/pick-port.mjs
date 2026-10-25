// Prints the first free TCP port at or above the one given (default 4310) on 127.0.0.1.
import { createServer } from "node:net";

function isFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

const start = Number(process.argv[2] ?? 4310);
for (let port = start; port < start + 200; port++) {
  if (await isFree(port)) {
    console.log(port);
    process.exit(0);
  }
}
console.error(`no free port found from ${start}`);
process.exit(1);
