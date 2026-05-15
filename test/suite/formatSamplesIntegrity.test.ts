import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function walkXmlFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkXmlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.xml')) {
      result.push(fullPath);
    }
  }
  return result;
}

suite('FormatSamples integrity', () => {
  test('empty_conf has no dangling form child references', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const configRoot = path.join(repoRoot, 'FormatSamples', 'empty_conf');
    const missing: string[] = [];

    for (const xmlPath of walkXmlFiles(configRoot)) {
      const xml = fs.readFileSync(xmlPath, 'utf8');
      const objectDir = path.join(path.dirname(xmlPath), path.basename(xmlPath, '.xml'));
      for (const match of xml.matchAll(/<Form>([^<]+)<\/Form>/g)) {
        const formName = match[1];
        const formPath = path.join(objectDir, 'Forms', `${formName}.xml`);
        if (!fs.existsSync(formPath)) {
          missing.push(path.relative(repoRoot, formPath));
        }
      }
    }

    assert.deepStrictEqual(missing, []);
  });
});
