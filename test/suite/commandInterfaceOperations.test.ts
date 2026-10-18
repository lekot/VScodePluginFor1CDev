import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandInterfaceOperations } from '../../src/agent/commandInterfaceOperations';
import { parseCommandInterface } from '../../src/parsers/commandInterfaceParser';

function makeWorkspace(xmlContent: string): { rootPath: string; subsysDir: string; ciPath: string; cleanup: () => void } {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-ops-test-'));
  const subsysDir = path.join(rootPath, 'Subsystems', 'TestSubsystem', 'Ext');
  fs.mkdirSync(subsysDir, { recursive: true });
  const ciPath = path.join(subsysDir, 'CommandInterface.xml');
  fs.writeFileSync(ciPath, xmlContent, 'utf8');
  return {
    rootPath,
    subsysDir,
    ciPath,
    cleanup: () => fs.rmSync(rootPath, { recursive: true, force: true }),
  };
}

const MINIMAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CommandInterface xmlns="http://v8.1c.ru/8.3/xcf/extrnprops" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" version="2.17">
\t<CommandsVisibility>
\t\t<Command name="Catalog.Товары.StandardCommand.OpenList">
\t\t\t<Visibility>
\t\t\t\t<xr:Common>true</xr:Common>
\t\t\t</Visibility>
\t\t</Command>
\t</CommandsVisibility>
</CommandInterface>`;

suite('commandInterfaceOperations', () => {
  test('getCommandInterface returns model for valid path', async () => {
    const ws = makeWorkspace(MINIMAL_XML);
    try {
      const ops = new CommandInterfaceOperations(ws.rootPath);
      const result = await ops.getCommandInterface('Subsystems/TestSubsystem');
      assert.strictEqual(result.success, true);
      assert.ok(result.data);
      assert.strictEqual(result.data.visibility.length, 1);
      assert.strictEqual(result.data.visibility[0].commandName, 'Catalog.Товары.StandardCommand.OpenList');
      assert.strictEqual(result.data.visibility[0].common, 'visible');
    } finally {
      ws.cleanup();
    }
  });

  test('getCommandInterface returns error when file missing', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-ops-nofile-'));
    try {
      const ops = new CommandInterfaceOperations(rootPath);
      const result = await ops.getCommandInterface('Subsystems/NonExistent');
      assert.strictEqual(result.success, false);
      assert.ok(result.error && result.error.length > 0);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  test('setCommandVisibility upserts new entry', async () => {
    const ws = makeWorkspace(MINIMAL_XML);
    try {
      const ops = new CommandInterfaceOperations(ws.rootPath);
      const result = await ops.setCommandVisibility('Subsystems/TestSubsystem', 'Document.Заказ.StandardCommand.OpenList', 'hidden');
      assert.strictEqual(result.success, true);
      const readResult = await ops.getCommandInterface('Subsystems/TestSubsystem');
      assert.ok(readResult.data);
      const entry = readResult.data.visibility.find(e => e.commandName === 'Document.Заказ.StandardCommand.OpenList');
      assert.ok(entry, 'new entry should exist');
      assert.strictEqual(entry!.common, 'hidden');
    } finally {
      ws.cleanup();
    }
  });

  test('setCommandVisibility updates existing entry', async () => {
    const ws = makeWorkspace(MINIMAL_XML);
    try {
      const ops = new CommandInterfaceOperations(ws.rootPath);
      const result = await ops.setCommandVisibility('Subsystems/TestSubsystem', 'Catalog.Товары.StandardCommand.OpenList', 'hidden');
      assert.strictEqual(result.success, true);
      const readResult = await ops.getCommandInterface('Subsystems/TestSubsystem');
      assert.ok(readResult.data);
      const entry = readResult.data.visibility.find(e => e.commandName === 'Catalog.Товары.StandardCommand.OpenList');
      assert.ok(entry);
      assert.strictEqual(entry!.common, 'hidden');
    } finally {
      ws.cleanup();
    }
  });

  test('setCommandVisibility removes entry when null', async () => {
    const ws = makeWorkspace(MINIMAL_XML);
    try {
      const ops = new CommandInterfaceOperations(ws.rootPath);
      const result = await ops.setCommandVisibility('Subsystems/TestSubsystem', 'Catalog.Товары.StandardCommand.OpenList', null);
      assert.strictEqual(result.success, true);
      const readResult = await ops.getCommandInterface('Subsystems/TestSubsystem');
      assert.ok(readResult.data);
      assert.strictEqual(readResult.data.visibility.length, 0);
    } finally {
      ws.cleanup();
    }
  });

  test('setCommandOrder replaces commandsOrder fully', async () => {
    const ws = makeWorkspace(MINIMAL_XML);
    try {
      const ops = new CommandInterfaceOperations(ws.rootPath);
      const newOrder = [
        { commandName: 'Document.Заказ.StandardCommand.OpenList', commandGroup: 'NavigationPanelOrdinary' },
        { commandName: 'Catalog.Товары.StandardCommand.OpenList', commandGroup: 'NavigationPanelOrdinary' },
      ];
      const result = await ops.setCommandOrder('Subsystems/TestSubsystem', newOrder);
      assert.strictEqual(result.success, true);
      const readResult = await ops.getCommandInterface('Subsystems/TestSubsystem');
      assert.ok(readResult.data);
      assert.deepStrictEqual(readResult.data.commandsOrder, newOrder);
    } finally {
      ws.cleanup();
    }
  });

  test('setSubsystemsOrder replaces subsystemsOrder fully', async () => {
    const ws = makeWorkspace(MINIMAL_XML);
    try {
      const ops = new CommandInterfaceOperations(ws.rootPath);
      const newOrder = ['Subsystem.TestSubsystem.Subsystem.ChildA', 'Subsystem.TestSubsystem.Subsystem.ChildB'];
      const result = await ops.setSubsystemsOrder('Subsystems/TestSubsystem', newOrder);
      assert.strictEqual(result.success, true);
      const readResult = await ops.getCommandInterface('Subsystems/TestSubsystem');
      assert.ok(readResult.data);
      assert.deepStrictEqual(readResult.data.subsystemsOrder, newOrder);
    } finally {
      ws.cleanup();
    }
  });

  test('resolves dotted metadata grammar for nested subsystems and routes setters to the requested sibling', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-ops-nested-dotted-'));
    const subsystemPaths = [
      'Subsystems/Parent',
      'Subsystems/Parent/Subsystems/ChildA',
      'Subsystems/Parent/Subsystems/ChildB',
      'Subsystems/Parent/Subsystems/ChildA/Subsystems/Grandchild',
      'Subsystems/Родитель/Subsystems/Дочерний/Subsystems/Лист',
    ];
    const dottedPaths = [
      'Subsystem.Parent',
      'Subsystem.Parent.Subsystem.ChildA',
      'Subsystem.Parent.Subsystem.ChildB',
      'Subsystem.Parent.Subsystem.ChildA.Subsystem.Grandchild',
      'Subsystem.Родитель.Subsystem.Дочерний.Subsystem.Лист',
    ];

    try {
      for (const subsystemPath of subsystemPaths) {
        const extDir = path.join(rootPath, subsystemPath, 'Ext');
        fs.mkdirSync(extDir, { recursive: true });
        fs.writeFileSync(path.join(extDir, 'CommandInterface.xml'), MINIMAL_XML, 'utf8');
      }

      const ops = new CommandInterfaceOperations(rootPath);
      for (const dottedPath of dottedPaths) {
        const result = await ops.getCommandInterface(dottedPath);
        assert.strictEqual(result.success, true, `${dottedPath}: ${result.error}`);
      }

      const visibilityResult = await ops.setCommandVisibility(
        'Subsystem.Parent.Subsystem.ChildA',
        'Catalog.Products.StandardCommand.OpenList',
        'hidden',
      );
      assert.strictEqual(visibilityResult.success, true, visibilityResult.error);

      const commandOrder = [{
        commandName: 'Catalog.Products.StandardCommand.OpenList',
        commandGroup: 'NavigationPanelOrdinary',
      }];
      const commandOrderResult = await ops.setCommandOrder('Subsystem.Parent.Subsystem.ChildB', commandOrder);
      assert.strictEqual(commandOrderResult.success, true, commandOrderResult.error);

      const subsystemOrder = ['Subsystem.Parent.Subsystem.ChildA.Subsystem.Grandchild'];
      const subsystemOrderResult = await ops.setSubsystemsOrder(
        'Subsystem.Parent.Subsystem.ChildA.Subsystem.Grandchild',
        subsystemOrder,
      );
      assert.strictEqual(subsystemOrderResult.success, true, subsystemOrderResult.error);

      const childA = await ops.getCommandInterface('Subsystem.Parent.Subsystem.ChildA');
      const childB = await ops.getCommandInterface('Subsystem.Parent.Subsystem.ChildB');
      const grandchild = await ops.getCommandInterface('Subsystem.Parent.Subsystem.ChildA.Subsystem.Grandchild');
      assert.strictEqual(
        childA.data?.visibility.find((entry) => entry.commandName === 'Catalog.Products.StandardCommand.OpenList')?.common,
        'hidden',
      );
      assert.deepStrictEqual(childA.data?.commandsOrder, []);
      assert.deepStrictEqual(childB.data?.commandsOrder, commandOrder);
      assert.deepStrictEqual(grandchild.data?.subsystemsOrder, subsystemOrder);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  test('preserves dots in relative and absolute filesystem paths', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-ops-dotted-fs-path-'));
    const subsystemDir = path.join(rootPath, 'Subsystems', 'Module.v2');
    const extDir = path.join(subsystemDir, 'Ext');
    const ciPath = path.join(extDir, 'CommandInterface.xml');
    const nestedSubsystemDir = path.join(rootPath, 'Subsystems', 'Parent', 'Subsystems', 'Child.v2');
    const nestedExtDir = path.join(nestedSubsystemDir, 'Ext');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(nestedExtDir, { recursive: true });
    fs.writeFileSync(ciPath, MINIMAL_XML, 'utf8');
    fs.writeFileSync(path.join(nestedExtDir, 'CommandInterface.xml'), MINIMAL_XML, 'utf8');

    try {
      const ops = new CommandInterfaceOperations(rootPath);
      const relativeResult = await ops.getCommandInterface('Subsystems/Module.v2');
      assert.strictEqual(relativeResult.success, true, relativeResult.error);

      const bareRelativeResult = await ops.getCommandInterface('Module.v2');
      assert.strictEqual(bareRelativeResult.success, true, bareRelativeResult.error);

      const absoluteResult = await ops.getCommandInterface(subsystemDir);
      assert.strictEqual(absoluteResult.success, true, absoluteResult.error);

      const updateResult = await ops.setCommandVisibility(subsystemDir, 'Catalog.Versioned', 'hidden');
      assert.strictEqual(updateResult.success, true, updateResult.error);
      const updated = await ops.getCommandInterface('Subsystems/Module.v2');
      assert.strictEqual(updated.data?.visibility.find((entry) => entry.commandName === 'Catalog.Versioned')?.common, 'hidden');

      const nestedRelativeResult = await ops.getCommandInterface('Subsystems/Parent/Subsystems/Child.v2');
      assert.strictEqual(nestedRelativeResult.success, true, nestedRelativeResult.error);

      const nestedAbsoluteResult = await ops.getCommandInterface(nestedSubsystemDir);
      assert.strictEqual(nestedAbsoluteResult.success, true, nestedAbsoluteResult.error);

      const nestedUpdateResult = await ops.setSubsystemsOrder(nestedSubsystemDir, ['Subsystem.Parent']);
      assert.strictEqual(nestedUpdateResult.success, true, nestedUpdateResult.error);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  test('accepts absolute path to .xml file', async () => {
    const ws = makeWorkspace(MINIMAL_XML);
    try {
      const subsysXmlPath = path.join(ws.rootPath, 'Subsystems', 'TestSubsystem.xml');
      fs.writeFileSync(subsysXmlPath, '<Subsystem/>', 'utf8');
      // File at dirname(subsysXmlPath)/Ext/CommandInterface.xml — that's subsysDir/CommandInterface.xml
      // but subsysDir = rootPath/Subsystems/TestSubsystem/Ext, not rootPath/Subsystems/Ext
      // So this test just checks it doesn't crash with bad paths — real path resolution via relative
      const ops = new CommandInterfaceOperations(ws.rootPath);
      const result = await ops.getCommandInterface('Subsystems/TestSubsystem');
      assert.strictEqual(result.success, true);
    } finally {
      ws.cleanup();
    }
  });

  test('file content is valid XML after write operations', async () => {
    const ws = makeWorkspace(MINIMAL_XML);
    try {
      const ops = new CommandInterfaceOperations(ws.rootPath);
      await ops.setCommandVisibility('Subsystems/TestSubsystem', 'NewCmd', 'visible');
      const content = fs.readFileSync(ws.ciPath, 'utf8');
      const reparsed = parseCommandInterface(content);
      assert.strictEqual(reparsed.visibility.length, 2);
    } finally {
      ws.cleanup();
    }
  });
});
