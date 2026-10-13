/** Only discard complete, small Claude thinking-counter frames. Unknown/malformed
 * frames and large/unterminated lines retain the ordinary hard output limit.
 * @param {(chunk:Buffer)=>void} emit */
export function telemetryFilter(emit) {
  let pending = Buffer.alloc(0), passthrough = false;
  const stats = { discardedTelemetryBytes: 0, discardedTelemetryFrames: 0 };
  return {
    stats,
    /** @param {Buffer} chunk */
    write(chunk) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline + 1;
        const part = chunk.subarray(start, end);
        if (passthrough || pending.length + part.length > 4096) {
          if (pending.length) { emit(pending); pending = Buffer.alloc(0); }
          emit(part); passthrough = newline < 0;
        } else {
          pending = Buffer.concat([pending, part]);
          if (newline >= 0) {
            let telemetry = false;
            try { const value = JSON.parse(pending.toString('utf8')); telemetry = value.type === 'system' && value.subtype === 'thinking_tokens'
              && Object.keys(value).every(key => ['type', 'subtype', 'estimated_tokens', 'estimated_tokens_delta', 'session_id', 'uuid'].includes(key))
              && Number.isFinite(value.estimated_tokens) && Number.isFinite(value.estimated_tokens_delta); } catch { /* Retain unknown output. */ }
            if (telemetry) { stats.discardedTelemetryBytes += pending.length; stats.discardedTelemetryFrames++; }
            else emit(pending);
            pending = Buffer.alloc(0);
          }
        }
        start = end;
      }
    },
    end() { if (pending.length) emit(pending); pending = Buffer.alloc(0); },
  };
}
