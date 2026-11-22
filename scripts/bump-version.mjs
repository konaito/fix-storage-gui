// 版番号を全ファイルで一度に書き換える。
// 使い方: node scripts/bump-version.mjs 0.3.0
import { parseArgs, setVersion } from './version-files.mjs';

try {
  const { root, rest } = parseArgs(process.argv.slice(2));
  if (rest.length !== 1) {
    console.error('使い方: node scripts/bump-version.mjs <X.Y.Z>');
    process.exit(2);
  }
  for (const v of setVersion(rest[0], root)) console.log(`${v.version}\t${v.file} (${v.label})`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
