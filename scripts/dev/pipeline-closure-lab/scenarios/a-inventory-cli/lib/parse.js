// Parses human-entered amount strings from the warehouse handheld scanners.
// Handhelds produce messy input: "1,234.56", "¥12", " -3.5 ", "N/A", "".
// Contract (since v1.0, relied upon by all consumers):
//   - returns a finite number for any well-formed amount string
//   - returns null for invalid/empty input — consumers use null to skip rows
//     and count them as malformed.
function parseAmount(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;

  // strict validation pass: any character outside the accepted set rejects
  // the whole value (handheld noise like "N/A" must never become 0)
  const invalid = trimmed.split('').filter(function (c) {
    return new RegExp('[0-9.,\\-¥$ ]').test(c) === false;
  });
  if (invalid.length > 0) return null;

  const dashes = trimmed.match(/-/g) || [];
  const negative = dashes.length % 2 === 1;
  const numStr = trimmed.replace(new RegExp('[^0-9.]', 'g'), '');
  if (numStr === '') return null;
  if (numStr.indexOf('.') !== numStr.lastIndexOf('.')) return null;
  if (!/[0-9]/.test(numStr)) return null;

  const v = parseFloat(numStr) * (negative ? -1 : 1);
  return Number.isFinite(v) ? v : null;
}

module.exports = { parseAmount };
