"use strict";

const { writeFileSync } = require("node:fs");

process.on("SIGTERM", () => {});
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1_000);
