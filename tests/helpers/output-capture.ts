import { Writable } from "node:stream";

export function createOutputCapture() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  return {
    write: stream.write.bind(stream),
    text: () => Buffer.concat(chunks).toString("utf8"),
    dispose: () => stream.destroy(),
  };
}
