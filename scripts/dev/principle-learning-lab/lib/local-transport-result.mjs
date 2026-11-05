// A successful host envelope cannot hide a missing request or forced shutdown.
export function classifyLocalTransport({ validationExit, hostExit, deadlineExceeded, requests, stdout, marker, reply, timings }) {
  let envelope;
  try { envelope = JSON.parse(stdout); } catch { /* No verified host envelope. */ }
  const transportConfirmed = requests.length === 1
    && requests[0].model === 'aa-probe'
    && requests[0].userMarkerPresent === true;
  const responseConfirmed = envelope?.ok === true && envelope?.status === 'ok'
    && envelope?.final === reply && envelope?.provider === 'aa-local'
    && envelope?.model === 'aa-probe';
  return {
    ok: validationExit === 0 && hostExit === 0 && !deadlineExceeded
      && transportConfirmed && responseConfirmed,
    validationExit, hostExit, deadlineExceeded, transportConfirmed, responseConfirmed,
    deadlinePhase: !deadlineExceeded ? null
      : typeof timings?.nativeExitMs === 'number' && typeof timings?.deadlineReachedMs === 'number'
        && timings.nativeExitMs < timings.deadlineReachedMs ? 'waiting_for_output_pipes'
        : typeof timings?.resultEnvelopeMs === 'number' ? 'after_result_output'
          : requests.length > 0 ? 'after_request_capture' : 'before_request_capture',
    requestCount: requests.length, marker,
    pdPrincipleDelivery: 'not_tested', behavioralImprovement: 'not_tested',
  };
}
