/**
 * Fixed child script for release-manager-payload-resolution.test.ts.
 *
 * Imports the module URL passed as argv[2] (--authority value) through the
 * NATIVE Node resolver — real physical-path resolution, no test-runner
 * rewriting — and reports the outcome on stdout:
 *   OK:<sorted export names>          on success
 *   ERR:<code>:<message>, exit 3      on failure
 * Pure argv data in, stdout out. No shell, no code interpolation (EP-08).
 */
const authorityUrl = process.argv[2] ?? '';
if (!authorityUrl.startsWith('file://')) {
  console.log('ERR:EUSAGE:--authority must be a file:// URL');
  process.exit(3);
}
import(authorityUrl)
  .then((m) => {
    console.log('OK:' + Object.keys(m).sort().join(','));
  })
  .catch((e) => {
    console.log('ERR:' + e.code + ':' + e.message);
    process.exit(3);
  });
