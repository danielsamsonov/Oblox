// Bounded HTTP reader which returns a useful 413 instead of destroying the connection.
module.exports = function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let finished = false;
    const chunks = [];
    function fail(message, status, code) {
      if (finished) return;
      finished = true;
      chunks.length = 0;
      const error = new Error(message); error.status = status; error.code = code; reject(error);
    }
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) { fail('Request is too large.', 413, 'payload_too_large'); return; }
      if (!finished) chunks.push(chunk);
    });
    req.once('end', () => {
      if (finished) return;
      finished = true; resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.once('aborted', () => fail('Request was interrupted.', 400, 'request_interrupted'));
    req.once('error', () => fail('Request was interrupted.', 400, 'request_interrupted'));
    if (Number(req.headers['content-length'] || 0) > limit) fail('Request is too large.', 413, 'payload_too_large');
  });
};
