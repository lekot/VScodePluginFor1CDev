import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emptyDirectoryContents } from '../../src/infobases/ibcmdExportTargetDir';

suite('ibcmdExportTargetDir', () => {
  test('emptyDirectoryContents removes files and subdirs, keeps root', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ibcmd-export-empty-'));
    await fs.promises.mkdir(path.join(root, 'sub'));
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'x', 'utf8');
    await fs.promises.writeFile(path.join(root, 'sub', 'b.txt'), 'y', 'utf8');

    await emptyDirectoryContents(root);

    const after = await fs.promises.readdir(root);
    assert.deepStrictEqual(after, []);
    assert.ok(fs.existsSync(root));
    await fs.promises.rm(root, { recursive: true, force: true });
  });
});
