// Privacy guard: MediaPipe Tasks Vision periodically POSTs usage / performance logs to
// https://odml.pa.googleapis.com/v1/log (vision_bundle.mjs, class "Fh", via fetch). Víbora Padel
// promises that nothing leaves the device, so those requests are answered locally with an empty
// 204 and never reach the network. MediaPipe treats the non-200 status as a failed send and stops
// its logging timer. Every other request passes through unchanged.
const BLOCKED = /^https?:\/\/odml\.pa\.googleapis\.com\//i;

export function installPrivacyGuard(target = globalThis) {
  const orig = target.fetch;
  if (typeof orig !== 'function' || orig.__viboraGuard) return;
  const guarded = function fetchGuarded(input, init) {
    const url = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : String(input);
    if (BLOCKED.test(url)) {
      return Promise.resolve(new Response(null, { status: 204, statusText: 'Blocked locally: no telemetry' }));
    }
    return orig.call(this, input, init);
  };
  guarded.__viboraGuard = true;
  target.fetch = guarded;
}
