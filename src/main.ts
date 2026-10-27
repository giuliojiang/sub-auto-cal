import { startServer } from "./server.ts";

const port = Number(process.argv[2] ?? 8080);
startServer(port);
