// Server-Sent Events helper. Opens an event stream on a raw http response and
// returns send/close. Heartbeat comments keep the connection alive through
// proxies/idle timeouts.

export function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // tell nginx-style proxies not to buffer
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');
  const hb = setInterval(() => {
    try {
      res.write(': hb\n\n');
    } catch {
      /* socket gone; close() will clear */
    }
  }, 15000);
  hb.unref?.();
  return {
    send(event) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      clearInterval(hb);
      try {
        res.end();
      } catch {
        /* already closed */
      }
    },
  };
}
