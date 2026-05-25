import { readFile, writeFile } from 'node:fs/promises'
import { findPackageJSON } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { positionals: [targetFile] } = parseArgs({
  allowPositionals: true,
})

if (!targetFile) {
  console.error("Usage: insertTranslationKeys <targetFile>")
  process.exit(1)
}

const packageJSONPath = path.dirname(findPackageJSON(import.meta.url)!)

const jsonfilePath = path.resolve(packageJSONPath, "./l10n//bundle.l10n.zh-CN.json")
const json = Object.entries(JSON.parse(await readFile(jsonfilePath, "utf-8")) as Record<string, string>)

console.error(`Loaded ${json.length} translation entries from ${jsonfilePath}.`)
let content = await readFile(targetFile, "utf-8")

const regex = (str: string) => new RegExp(
  String.raw`(?<=l10n\.t\(")${RegExp.escape(str)}(?=")`,
  "g"
)

let totalCount = 0
for (const [key, value] of json) {
  let count = 0
  content = content.replaceAll(regex(value), () => {
    count++
    return key
  })
  if (count > 0) console.error(`Replaced ${count} occurrences for "${key}".`)
  totalCount += count
}

console.error(`Total replacements: ${totalCount}`)

await writeFile(targetFile, content, "utf-8")

console.error(`Updated file written to <pkg>/${path.relative(packageJSONPath, targetFile)}.`)
