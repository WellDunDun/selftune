Object.defineProperty(process.stdout, "isTTY", {
  configurable: true,
  value: true,
});

await import("../../../apps/cli/src/main.js");
