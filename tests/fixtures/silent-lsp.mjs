#!/usr/bin/env node
// Fault fixture: accepts initialize but never publishes diagnostics or shuts down.
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === 'initialize') {
      const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
      // Split a frame across chunks to exercise incremental byte framing.
      const data = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      process.stdout.write(data.subarray(0, 23));
      setTimeout(() => process.stdout.write(data.subarray(23)), 10);
    }
  }
});
