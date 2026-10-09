import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandInterfaceOperations } from '../../src/agent/commandInterfaceOperations';

const MINIMAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
\t<CommandsVisibility>
\t\t<Command name="Catalog.Goods.StandardCommand.OpenList">
\t\t\t<Visibility><xr:Common>true</xr:Common></Visibility>
\t\t</Command>
\t</CommandsVisibility>
</CommandInterface>`;

suite('CommandInterfaceOperations Subsystem Path Containment (Issue #209)', () => {
  let rootA: string;
  let rootB: string;

  setup(async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ci-containment-'));
    rootA = path.join(tmp, 'configA');
    rootB = path.join(tmp, 'configB');
    await fs.promises.mkdir(path.join(rootA, 'Subsystems', 'SubA', 'Ext'), { recursive: true });
    await fs.promises.mkdir(path.join(rootB, 'Subsystems', 'SubB', 'Ext'), { recursive: true });
    await fs.promises.writeFile(path.join(rootA, 'Subsystems', 'SubA', 'Ext', 'CommandInterface.xml'), MINIMAL_XML, 'utf8');
    await fs.promises.writeFile(path.join(rootB, 'Subsystems', 'SubB', 'Ext', 'CommandInterface.xml'), MINIMAL_XML, 'utf8');
  });

  teardown(async () => {
    const parent = path.dirname(rootA);
    await fs.promises.rm(parent, { recursive: true, force: true }).catch(() => undefined);
  });

  test('rejects absolute path pointing outside configuration root on read', async () => {
    const opsA = new CommandInterfaceOperations(rootA);
    const outsideTarget = path.join(rootB, 'Subsystems', 'SubB', 'Ext', 'CommandInterface.xml');
    const result = await opsA.getCommandInterface(outsideTarget);
    assert.strictEqual(result.success, false, 'External path must be rejected');
    assert.ok(
      result.error && (result.error.includes('границы') || result.error.includes('outside') || result.code === 'TARGET_OUTSIDE_ROOT'),
      `Expected containment error, got: ${result.error}`,
    );
  });

  test('rejects absolute path pointing outside configuration root on write', async () => {
    const opsA = new CommandInterfaceOperations(rootA);
    const outsideTarget = path.join(rootB, 'Subsystems', 'SubB');
    const result = await opsA.setCommandVisibility(outsideTarget, 'Catalog.Goods.StandardCommand.OpenList', 'hidden');
    assert.strictEqual(result.success, false, 'External write path must be rejected');
    assert.ok(
      result.error && (result.error.includes('границы') || result.error.includes('outside') || result.code === 'TARGET_OUTSIDE_ROOT'),
      `Expected containment error, got: ${result.error}`,
    );
  });

  test('rejects relative path with traversal escaping configuration root', async () => {
    const opsA = new CommandInterfaceOperations(rootA);
    const escapingPath = '../../configB/Subsystems/SubB';
    const result = await opsA.getCommandInterface(escapingPath);
    assert.strictEqual(result.success, false, 'Traversal path must be rejected');
  });

  test('allows valid absolute path strictly within configuration root', async () => {
    const opsA = new CommandInterfaceOperations(rootA);
    const insideTarget = path.join(rootA, 'Subsystems', 'SubA');
    const result = await opsA.getCommandInterface(insideTarget);
    assert.strictEqual(result.success, true, `Inside absolute path should be accepted: ${result.error}`);
    assert.ok(result.data);
  });

  test('setCommandOrder rejects external path', async () => {
    const opsA = new CommandInterfaceOperations(rootA);
    const outsideTarget = path.join(rootB, 'Subsystems', 'SubB');
    const result = await opsA.setCommandOrder(outsideTarget, []);
    assert.strictEqual(result.success, false);
    assert.ok(result.error && (result.error.includes('границы') || result.error.includes('outside') || result.code === 'TARGET_OUTSIDE_ROOT'));
  });

  test('setSubsystemsOrder rejects external path', async () => {
    const opsA = new CommandInterfaceOperations(rootA);
    const outsideTarget = path.join(rootB, 'Subsystems', 'SubB');
    const result = await opsA.setSubsystemsOrder(outsideTarget, []);
    assert.strictEqual(result.success, false);
    assert.ok(result.error && (result.error.includes('границы') || result.error.includes('outside') || result.code === 'TARGET_OUTSIDE_ROOT'));
  });

  test('nested subsystem inside configuration root is accepted', async () => {
    const nestedDir = path.join(rootA, 'Subsystems', 'SubA', 'Subsystems', 'Nested', 'Ext');
    await fs.promises.mkdir(nestedDir, { recursive: true });
    await fs.promises.writeFile(path.join(nestedDir, 'CommandInterface.xml'), MINIMAL_XML, 'utf8');

    const opsA = new CommandInterfaceOperations(rootA);
    const result = await opsA.getCommandInterface('Subsystems/SubA/Subsystems/Nested');
    assert.strictEqual(result.success, true);
    assert.ok(result.data);
  });

  test('resolves command interface via absolute xml file path and short subsystem name under Subsystems', async () => {
    const opsA = new CommandInterfaceOperations(rootA);
    // Absolute XML file path (e.g. Subsystem XML descriptor)
    const directXmlPath = path.join(rootA, 'Subsystems', 'SubA', 'SubA.xml');
    const xmlRes = await opsA.getCommandInterface(directXmlPath);
    assert.strictEqual(xmlRes.success, true);

    // Relative under Subsystems directly
    const shortRes = await opsA.getCommandInterface('SubA');
    assert.strictEqual(shortRes.success, true);
  });

  test('setCommandVisibility updates existing, adds new, and removes commands', async () => {
    const opsA = new CommandInterfaceOperations(rootA);
    // 1. Update existing command
    const resUpdate = await opsA.setCommandVisibility('Subsystems/SubA', 'Catalog.Goods.StandardCommand.OpenList', 'hidden');
    assert.strictEqual(resUpdate.success, true);

    // 2. Add new command
    const resAdd = await opsA.setCommandVisibility('Subsystems/SubA', 'Catalog.New.Command', 'visible');
    assert.strictEqual(resAdd.success, true);

    // 3. Remove command (common === null)
    const resRemove = await opsA.setCommandVisibility('Subsystems/SubA', 'Catalog.Goods.StandardCommand.OpenList', null);
    assert.strictEqual(resRemove.success, true);

    const getRes = await opsA.getCommandInterface('Subsystems/SubA');
    assert.strictEqual(getRes.success, true);
    assert.strictEqual(getRes.data?.visibility.some((v) => v.commandName === 'Catalog.Goods.StandardCommand.OpenList'), false);
    assert.strictEqual(getRes.data?.visibility.some((v) => v.commandName === 'Catalog.New.Command'), true);
  });

  test('setCommandOrder and setSubsystemsOrder succeed inside configuration root', async () => {
    const opsA = new CommandInterfaceOperations(rootA);
    const resOrder = await opsA.setCommandOrder('Subsystems/SubA', [
      { commandName: 'Catalog.Goods.StandardCommand.OpenList', commandGroup: 'CommonCommand.Group' },
    ]);
    assert.strictEqual(resOrder.success, true);

    const resSubOrder = await opsA.setSubsystemsOrder('Subsystems/SubA', ['SubA1', 'SubA2']);
    assert.strictEqual(resSubOrder.success, true);

    const getRes = await opsA.getCommandInterface('Subsystems/SubA');
    assert.strictEqual(getRes.success, true);
    assert.strictEqual(getRes.data?.commandsOrder?.length, 1);
    assert.deepStrictEqual(getRes.data?.subsystemsOrder, ['SubA1', 'SubA2']);
  });

  test('returns error when command interface file does not exist', async () => {
    const opsA = new CommandInterfaceOperations(rootA);
    const getRes = await opsA.getCommandInterface('Subsystems/NonExistent');
    assert.strictEqual(getRes.success, false);
    assert.ok(getRes.error?.includes('не найден'));

    const visRes = await opsA.setCommandVisibility('Subsystems/NonExistent', 'cmd', 'visible');
    assert.strictEqual(visRes.success, false);
    assert.ok(visRes.error?.includes('не найден'));

    const ordRes = await opsA.setCommandOrder('Subsystems/NonExistent', []);
    assert.strictEqual(ordRes.success, false);
    assert.ok(ordRes.error?.includes('не найден'));

    const subOrdRes = await opsA.setSubsystemsOrder('Subsystems/NonExistent', []);
    assert.strictEqual(subOrdRes.success, false);
    assert.ok(subOrdRes.error?.includes('не найден'));
  });

  test('handles PATH_UNAVAILABLE when configuration root is non-existent', async () => {
    const brokenOps = new CommandInterfaceOperations(path.join(os.tmpdir(), 'completely-missing-root-for-ci'));
    const getRes = await brokenOps.getCommandInterface('SubA');
    assert.strictEqual(getRes.success, false);
    assert.strictEqual(getRes.code, 'PATH_UNAVAILABLE');

    const visRes = await brokenOps.setCommandVisibility('SubA', 'cmd', 'visible');
    assert.strictEqual(visRes.success, false);
    assert.strictEqual(visRes.code, 'PATH_UNAVAILABLE');

    const ordRes = await brokenOps.setCommandOrder('SubA', []);
    assert.strictEqual(ordRes.success, false);
    assert.strictEqual(ordRes.code, 'PATH_UNAVAILABLE');

    const subOrdRes = await brokenOps.setSubsystemsOrder('SubA', []);
    assert.strictEqual(subOrdRes.success, false);
    assert.strictEqual(subOrdRes.code, 'PATH_UNAVAILABLE');
  });
});

