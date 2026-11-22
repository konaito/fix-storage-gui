// 版番号が全ファイルで一致するかを調べる。ずれていれば終了コード 1 で止まる。
// 使い方: node scripts/check-version.mjs
import { parseArgs, readVersions } from './version-files.mjs';

try {
  const { root } = parseArgs(process.argv.slice(2));
  const versions = readVersions(root);
  for (const v of versions) console.log(`${v.version}\t${v.file} (${v.label})`);
  const distinct = new Set(versions.map((v) => v.version));
  if (distinct.size !== 1) {
    console.error(`::error::版番号がファイルごとにずれている（${[...distinct].join(', ')}）。node scripts/bump-version.mjs <版> でそろえてほしい`);
    process.exit(1);
  }
  console.log(`OK: すべて ${versions[0].version}`);
} catch (e) {
  console.error(`::error::${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
