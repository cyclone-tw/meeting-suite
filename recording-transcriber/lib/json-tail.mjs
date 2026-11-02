// Tools in this package print progress and then a final JSON summary on
// stdout; engines may print their own JSON first. Parse the last complete
// top-level JSON object instead of guessing from one marker.
export function parseLastJson(text) {
  const value = String(text || "");
  let index = value.length;
  while ((index = value.lastIndexOf("{", index - 1)) >= 0) {
    if (index > 0 && value[index - 1] !== "\n") continue;
    try {
      return JSON.parse(value.slice(index));
    } catch {
      // keep scanning backwards
    }
    if (index === 0) break;
  }
  return null;
}
