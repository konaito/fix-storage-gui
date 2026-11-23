/** What "「削除していい」をすべて選択" selects: the current selection plus every safe item, so items picked by hand stay (#35). */
export function withAllSafe(selected: Iterable<string>, safe: string[]): string[] {
  return [...new Set([...selected, ...safe])];
}
