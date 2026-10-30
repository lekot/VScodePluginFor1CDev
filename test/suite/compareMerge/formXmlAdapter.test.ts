import * as assert from 'assert';
import * as path from 'path';

import { CompareSession } from '../../../src/compareMerge/domain/compareSession';
import type { CompareTreeNode } from '../../../src/compareMerge/compareTreeTypes';
import { formXmlAdapter } from '../../../src/compareMerge/adapters/formXmlAdapter';
import type { AdapterCompareInput } from '../../../src/compareMerge/adapters/mergeAdapter';
import { applySelectedXmlPatches } from '../../../src/compareMerge/merge/semanticXmlMerge';
import { elementChildren, parseXmlDocument, textContent, type XmlElement } from '../../../src/compareMerge/xml/xmlDom';
import { applyXmlPatch } from '../../../src/compareMerge/xml/xmlPatch';

suite('Form XML merge adapter', () => {
  test('groups form item property diffs under known form sections', async () => {
    const result = await formXmlAdapter.compare(
      makeInput({
        left: [
          '<Form>',
          '  <ChildItems>',
          '    <Item>',
          '      <Name>ItemsTable</Name>',
          '      <Title>Old title</Title>',
          '    </Item>',
          '  </ChildItems>',
          '</Form>',
        ].join('\n'),
        right: [
          '<Form>',
          '  <ChildItems>',
          '    <Item>',
          '      <Name>ItemsTable</Name>',
          '      <Title>New title</Title>',
          '    </Item>',
          '  </ChildItems>',
          '</Form>',
        ].join('\n'),
      })
    );

    const group = requireNodeByLabel(result.nodes, 'ChildItems');
    const item = requireNodeByLabel(group.children, 'ItemsTable');
    const title = requireNodeByLabel(item.children, 'Title');

    assert.strictEqual(group.kind, 'formGroup');
    assert.strictEqual(item.kind, 'formItem');
    assert.strictEqual(title.kind, 'xmlProperty');
    assert.strictEqual(title.status, 'changed');
    assert.strictEqual(title.leftValue, 'Old title');
    assert.strictEqual(title.rightValue, 'New title');
    assert.strictEqual(title.mergeable, true);
    assert.ok(result.candidateFactories.has(title.id));
  });

  test('builds executable right-only form item subtree candidate', async () => {
    const left = '<Form><ChildItems></ChildItems></Form>';
    const result = await formXmlAdapter.compare(
      makeInput({
        left,
        right: [
          '<Form>',
          '  <ChildItems>',
          '    <Item id="new">',
          '      <Name>NewItem</Name>',
          '      <Title>Created</Title>',
          '    </Item>',
          '  </ChildItems>',
          '</Form>',
        ].join('\n'),
      })
    );

    const item = requireNodeByLabel(result.nodes, 'NewItem');

    assert.strictEqual(item.kind, 'formItem');
    assert.strictEqual(item.status, 'rightOnly');
    assert.strictEqual(item.mergeable, true);
    assert.ok(result.candidateFactories.has(item.id));

    const candidateResult = await result.candidateFactories.get(item.id)!();
    assert.strictEqual(candidateResult.ok, true);
    const applied = applyXmlPatch(left, candidateResult.candidate.xmlPatch!);
    assert.match(applied, /<Item id="new">\s*<Name>NewItem<\/Name>\s*<Title>Created<\/Title>\s*<\/Item>/);
  });

  test('projects missing Events wrappers as individually selectable linked Event patches', async () => {
    const left = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><ChildItems><InputField name="Field" id="1"><Title>Target only</Title></InputField></ChildItems><Attributes/><Commands/></Form>';
    const right = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><ChildItems><InputField name="Field" id="1"><Events><Event name="OnOpen">OnOpen</Event><Event name="OnClose">OnClose</Event></Events></InputField></ChildItems><Attributes/><Commands/></Form>';
    const input = makeInput({ left, right });
    input.linkedDesignerContext = {
      registrations: [],
      defaultObjectForms: [],
      formEventHandlers: [
        { name: 'OnOpen', targetHasHandler: true },
        { name: 'OnClose', targetHasHandler: true },
      ],
    };
    const result = await formXmlAdapter.compare(input);
    const events = collectNodes(result.nodes, (node) => node.payloadRef?.includes('/Event[') === true);
    assert.deepStrictEqual(events.map((node) => node.label), ['Событие: OnOpen', 'Событие: OnClose']);
    assert.ok(events.every((node) => node.mergeable && node.kind === 'xmlProperty'));

    const candidates = await Promise.all(events.map((node) => result.candidateFactories.get(node.id)!()));
    assert.ok(candidates.every((candidate) => candidate.ok));
    if (candidates.some((candidate) => !candidate.ok)) {return;}
    const patches = candidates.map((candidate) => candidate.candidate.xmlPatch!);
    assert.ok(patches.every((patch) => (patch as unknown as { createDestinationEvents?: boolean }).createDestinationEvents === true));
    const applied = applySelectedXmlPatches(left, [...patches].reverse());
    assert.strictEqual(applied.ok, true, applied.ok ? undefined : applied.message);
    if (!applied.ok) {return;}
    const root = parseForm(applied.source);
    const field = findById(root, '1');
    assert.deepStrictEqual(elementChildren(findChild(field, 'Events')).map((event) => event.attributes.find((attribute) => attribute.localName === 'name')?.value), ['OnOpen', 'OnClose']);
    assert.strictEqual(textContent(findChild(field, 'Title')), 'Target only');

    const repeated = await formXmlAdapter.compare({ ...input, snapshots: { left: applied.source, right } });
    const repeatedNodes = collectNodes(repeated.nodes, () => true);
    assert.deepStrictEqual(
      repeatedNodes.filter((node) => node.mergeState?.state === 'ready').map((node) => node.label),
      ['Title'],
      'the Event set is already merged; the only remaining candidate is the intentionally unselected target-only Title',
    );
    assert.strictEqual(repeated.candidateFactories.size, 1);
  });

  test('projects a cross-parent visual move as one placement candidate and keeps field edits independent', async () => {
    const left = formWithGroups(
      '<UsualGroup name="Source" id="1"><ChildItems><InputField name="Field" id="2"><Title>Target title</Title></InputField></ChildItems></UsualGroup>',
      '<UsualGroup name="Destination" id="3"><ChildItems><Button name="Anchor" id="4"/><LabelField name="Local" id="5"/></ChildItems></UsualGroup>'
    );
    const right = formWithGroups(
      '<UsualGroup name="Source" id="1"><ChildItems/></UsualGroup>',
      '<UsualGroup name="Destination" id="3"><ChildItems><InputField name="Field" id="2"><Title>Source title</Title></InputField><Button name="Anchor" id="4"/><LabelField name="Local" id="5"/></ChildItems></UsualGroup>'
    );
    const result = await formXmlAdapter.compare(makeInput({ left, right }));
    const placement = requireNodeByLabel(result.nodes, 'Размещение: Field');
    const title = requireNodeByLabel(result.nodes, 'Title');

    assert.strictEqual(placement.kind, 'formPlacement');
    assert.strictEqual(placement.status, 'changed');
    assert.strictEqual(placement.mergeable, true);
    assert.strictEqual(title.kind, 'xmlProperty');
    assert.strictEqual(title.leftValue, 'Target title');
    assert.strictEqual(title.rightValue, 'Source title');

    const placementResult = await result.candidateFactories.get(placement.id)!();
    const titleResult = await result.candidateFactories.get(title.id)!();
    assert.strictEqual(placementResult.ok, true);
    assert.strictEqual(titleResult.ok, true);
    if (!placementResult.ok || !titleResult.ok) {return;}
    assert.strictEqual(placementResult.candidate.kind, 'xmlNodeMove');
    assert.strictEqual(placementResult.candidate.xmlPatch?.kind, 'moveNode');
    assert.ok(placementResult.candidate.xmlPatch?.destinationParent?.pointer?.includes('UsualGroup[id%3D3]/ChildItems['));
    assert.strictEqual(placementResult.candidate.xmlPatch?.insertBefore?.identityKey, 'id=4');
    assert.strictEqual(placementResult.candidate.xmlPatch?.replacementXml, undefined);

    const applied = applySelectedXmlPatches(left, [placementResult.candidate.xmlPatch!, titleResult.candidate.xmlPatch!]);
    assert.strictEqual(applied.ok, true, applied.ok ? undefined : applied.message);
    if (!applied.ok) {return;}
    const reapplied = await formXmlAdapter.compare(makeInput({ left: applied.source, right }));
    assert.strictEqual(reapplied.candidateFactories.size, 0, 'the resulting target should compare equal to the same source');
  });

  test('interleaves selected cross-parent moves and new siblings by source order around a shared anchor', async () => {
    const left = formWithGroups(
      '<InputField name="A" id="2"/>',
      '<UsualGroup name="Destination" id="3"><ChildItems><Button name="B" id="4"/></ChildItems></UsualGroup>'
    );
    const right = formWithGroups(
      '',
      '<UsualGroup name="Destination" id="3"><ChildItems><LabelField name="N" id="5"/><InputField name="A" id="2"/><Button name="B" id="4"/></ChildItems></UsualGroup>'
    );
    const result = await formXmlAdapter.compare(makeInput({ left, right }));
    const moveNode = requireNodeByLabel(result.nodes, 'Размещение: A');
    const insertNode = requireNodeByLabel(result.nodes, 'N');
    const move = await result.candidateFactories.get(moveNode.id)!();
    const insert = await result.candidateFactories.get(insertNode.id)!();
    assert.strictEqual(move.ok, true);
    assert.strictEqual(insert.ok, true);
    if (!move.ok || !insert.ok) {return;}
    assert.strictEqual(move.candidate.xmlPatch?.insertBefore?.identityKey, 'id=4');
    assert.strictEqual(insert.candidate.xmlPatch?.insertBefore?.identityKey, 'id=4');
    assert.strictEqual(move.candidate.xmlPatch?.insertOrder, 1);
    assert.strictEqual(insert.candidate.xmlPatch?.insertOrder, 0);

    const selected = [move.candidate.xmlPatch!, insert.candidate.xmlPatch!];
    for (const patches of [selected, [...selected].reverse()]) {
      const applied = applySelectedXmlPatches(left, patches);
      assert.strictEqual(applied.ok, true, applied.ok ? undefined : applied.message);
      if (!applied.ok) {return;}
      const destinationItems = findChild(findById(parseForm(applied.source), '3'), 'ChildItems');
      assert.deepStrictEqual(elementIds(destinationItems), ['5', '2', '4']);
    }
  });

  test('creates missing ChildItems on a matched visual owner as part of a placement move', async () => {
    const left = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><ChildItems><UsualGroup name="Source" id="1"><ChildItems><InputField name="Field" id="2"/></ChildItems></UsualGroup><UsualGroup name="Destination" id="3"><Title>Target-only title</Title></UsualGroup></ChildItems><Attributes/><Commands/></Form>';
    const right = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><ChildItems><UsualGroup name="Source" id="1"><ChildItems/></UsualGroup><UsualGroup name="Destination" id="3"><Title>Target-only title</Title><ChildItems><InputField name="Field" id="2"/></ChildItems></UsualGroup></ChildItems><Attributes/><Commands/></Form>';
    const result = await formXmlAdapter.compare(makeInput({ left, right }));
    const placement = requireNodeByLabel(result.nodes, 'Размещение: Field');
    const candidate = await result.candidateFactories.get(placement.id)!();
    assert.strictEqual(candidate.ok, true);
    if (!candidate.ok) {return;}
    assert.strictEqual(candidate.candidate.xmlPatch?.createDestinationChildItems, true);
    assert.match(candidate.candidate.xmlPatch?.destinationParent?.pointer ?? '', /UsualGroup\[id%3D3\]\/ChildItems\[0\]$/u);

    const applied = applySelectedXmlPatches(left, [candidate.candidate.xmlPatch!]);
    assert.strictEqual(applied.ok, true, applied.ok ? undefined : applied.message);
    if (!applied.ok) {return;}
    const merged = parseForm(applied.source);
    const destination = findById(merged, '3');
    assert.deepStrictEqual(elementChildren(destination).map((element) => element.localName), ['Title', 'ChildItems']);
    assert.strictEqual(findById(merged, '2').parent, findChild(destination, 'ChildItems'));
    assert.match(applied.source, /Target-only title/u);
  });

  test('projects sibling reordering as source-ordered moves without a read-only order node', async () => {
    const left = formWithGroups(
      '<InputField name="First" id="1"/><Button name="Second" id="2"/><LabelField name="Third" id="3"/>',
      ''
    );
    const right = formWithGroups(
      '<Button name="Second" id="2"/><InputField name="First" id="1"/><LabelField name="Third" id="3"/>',
      ''
    );
    const result = await formXmlAdapter.compare(makeInput({ left, right }));
    const placements = collectNodes(result.nodes, (node) => node.kind === 'formPlacement');

    assert.strictEqual(placements.length, 1);
    assert.strictEqual(placements[0]?.label, 'Размещение: Second');
    assert.ok(!collectNodes(result.nodes, (node) => node.kind === 'xmlOrder').length);
    const candidate = await result.candidateFactories.get(placements[0]!.id)!();
    assert.strictEqual(candidate.ok, true);
    if (candidate.ok) {
      assert.strictEqual(candidate.candidate.xmlPatch?.insertBefore?.identityKey, 'id=1');
      const applied = applySelectedXmlPatches(left, [candidate.candidate.xmlPatch!]);
      assert.strictEqual(applied.ok, true, applied.ok ? undefined : applied.message);
      if (applied.ok) {
        assert.deepStrictEqual(elementIds(findChild(parseForm(applied.source), 'ChildItems')), ['2', '1', '3']);
      }
    }
  });

  test('anchors a selected move to the next source sibling even when that sibling is another candidate', async () => {
    const left = formWithGroups(
      '<InputField name="A" id="1"/><Button name="B" id="2"/><LabelField name="C" id="3"/>',
      ''
    );
    const right = formWithGroups(
      '<LabelField name="C" id="3"/><Button name="B" id="2"/><InputField name="A" id="1"/>',
      ''
    );
    const result = await formXmlAdapter.compare(makeInput({ left, right }));
    const candidateNodes = collectNodes(result.nodes, (node) => node.kind === 'formPlacement');
    const cPlacement = candidateNodes.find((node) => node.label === 'Размещение: C');
    const bPlacement = candidateNodes.find((node) => node.label === 'Размещение: B');
    assert.ok(cPlacement);
    assert.ok(bPlacement);

    const cCandidate = await result.candidateFactories.get(cPlacement.id)!();
    const bCandidate = await result.candidateFactories.get(bPlacement.id)!();
    assert.strictEqual(cCandidate.ok, true);
    assert.strictEqual(bCandidate.ok, true);
    if (!cCandidate.ok || !bCandidate.ok) {return;}
    assert.strictEqual(cCandidate.candidate.xmlPatch?.insertBefore?.identityKey, 'id=2');

    const onlyC = applySelectedXmlPatches(left, [cCandidate.candidate.xmlPatch!]);
    assert.strictEqual(onlyC.ok, true, onlyC.ok ? undefined : onlyC.message);
    if (onlyC.ok) {
      assert.deepStrictEqual(elementIds(findChild(parseForm(onlyC.source), 'ChildItems')), ['1', '3', '2']);
    }
    const both = applySelectedXmlPatches(left, [bCandidate.candidate.xmlPatch!, cCandidate.candidate.xmlPatch!]);
    assert.strictEqual(both.ok, true, both.ok ? undefined : both.message);
    if (both.ok) {
      assert.deepStrictEqual(elementIds(findChild(parseForm(both.source), 'ChildItems')), ['3', '2', '1']);
    }
  });

  test('moves nested command-bar controls and reorders the shared visual registry', async () => {
    const left = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><Attributes/><Commands/><ChildItems>' +
      '<CommandBar name="Toolbar" id="10"><ChildItems><ButtonGroup name="Actions" id="11"><ChildItems>' +
      '<Button name="First" id="12"/><Button name="Second" id="13"/>' +
      '</ChildItems></ButtonGroup><Popup name="More" id="14"><ChildItems><Button name="MenuAction" id="15"/></ChildItems></Popup></ChildItems></CommandBar>' +
      '<UsualGroup name="Destination" id="20"><Title>Keep local title</Title><ChildItems>' +
      '<CalendarField name="Calendar" id="21"/><PictureDecoration name="Picture" id="22"/><Button name="Stay" id="23"/>' +
      '</ChildItems></UsualGroup></ChildItems></Form>';
    const right = '<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><Attributes/><Commands/><ChildItems>' +
      '<CommandBar name="Toolbar" id="10"><ChildItems><ButtonGroup name="Actions" id="11"><ChildItems>' +
      '<Button name="Second" id="13"/><Button name="First" id="12"/>' +
      '</ChildItems></ButtonGroup></ChildItems></CommandBar>' +
      '<UsualGroup name="Destination" id="20"><Title>Keep local title</Title><ChildItems>' +
      '<PictureDecoration name="Picture" id="22"/><Popup name="More" id="14"><ChildItems><Button name="MenuAction" id="15"/></ChildItems></Popup>' +
      '<CalendarField name="Calendar" id="21"/><Button name="Stay" id="23"/>' +
      '</ChildItems></UsualGroup></ChildItems></Form>';
    const result = await formXmlAdapter.compare(makeInput({ left, right }));
    const placements = collectNodes(result.nodes, (node) => node.kind === 'formPlacement' && node.mergeable === true);
    const popup = placements.find((node) => node.label === 'Размещение: More');
    const buttonReorder = placements.find((node) => ['Размещение: First', 'Размещение: Second'].includes(node.label));
    const commonControlReorder = placements.find((node) => ['Размещение: Calendar', 'Размещение: Picture'].includes(node.label));
    assert.ok(popup, 'Popup must be movable between a CommandBar and a visual group');
    assert.ok(buttonReorder, 'ButtonGroup children must support source-order moves');
    assert.ok(commonControlReorder, 'CalendarField and PictureDecoration must share the visual identity registry');
    assert.ok(!collectNodes(result.nodes, (node) => node.kind === 'xmlOrder').length);

    const selectedNodes = [popup!, buttonReorder!, commonControlReorder!];
    for (const node of selectedNodes) {
      assert.match(node.leftValue ?? '', / → позиция \d+$/u);
      assert.match(node.rightValue ?? '', / → (?:перед |позиция )/u);
    }
    const candidateResults = await Promise.all(selectedNodes.map((node) => result.candidateFactories.get(node.id)!()));
    assert.ok(candidateResults.every((candidate) => candidate.ok));
    if (candidateResults.some((candidate) => !candidate.ok)) {return;}
    const applied = applySelectedXmlPatches(left, candidateResults.map((candidate) => candidate.candidate.xmlPatch!));
    assert.strictEqual(applied.ok, true, applied.ok ? undefined : applied.message);
    if (!applied.ok) {return;}
    const merged = parseForm(applied.source);
    const destination = findById(merged, '20');
    const destinationItems = findChild(destination, 'ChildItems');
    assert.deepStrictEqual(elementIds(destinationItems), ['22', '14', '21', '23']);
    assert.strictEqual(findById(merged, '14').parent, destinationItems);
    assert.deepStrictEqual(elementIds(findChild(findById(merged, '11'), 'ChildItems')), ['13', '12']);
    assert.match(applied.source, /Keep local title/u);
  });
});

function formWithGroups(sourceItems: string, destinationGroup: string): string {
  return `<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.20"><Attributes/><Commands/><ChildItems>${sourceItems}${destinationGroup}</ChildItems></Form>`;
}

function parseForm(source: string): XmlElement {
  return parseXmlDocument(source).root;
}

function elementIds(parent: XmlElement): string[] {
  return elementChildren(parent).map((element) => element.attributes.find((attribute) => attribute.localName === 'id')?.value ?? '');
}

function findChild(parent: XmlElement, name: string): XmlElement {
  const child = elementChildren(parent).find((element) => element.localName === name);
  assert.ok(child, `Expected child ${name}.`);
  return child;
}

function findById(root: XmlElement, id: string): XmlElement {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.attributes.some((attribute) => attribute.localName === 'id' && attribute.value === id)) {
      return current;
    }
    pending.push(...elementChildren(current));
  }
  throw new Error(`Element with id ${id} was not found.`);
}

function makeInput(snapshots: { left: string; right: string }): AdapterCompareInput {
  return {
    strategy: 'full',
    leftInventory: { rootPath: 'left', objects: [], artifactsByObjectId: new Map() },
    rightInventory: { rootPath: 'right', objects: [], artifactsByObjectId: new Map() },
    match: {
      left: metadataObject('left-object', path.join('left', 'Catalogs', 'Products.xml'), 'left'),
      right: metadataObject('right-object', path.join('right', 'Catalogs', 'Products.xml'), 'right'),
    },
    session: makeSession(),
    snapshots,
  };
}

function metadataObject(objectId: string, descriptorPath: string, containerPath: string) {
  return {
    objectId,
    qualifiedName: 'Catalog.Products',
    metadataType: 'Catalog',
    descriptorPath,
    containerPath,
  };
}

function makeSession(): CompareSession {
  const session = CompareSession.create({
    sessionId: 'session-1',
    createdAt: '2026-05-30T10:00:00.000Z',
    sources: [
      {
        sourceId: 'left-source',
        side: 'left',
        kind: 'workspace',
        displayName: 'Left',
        rootUri: 'file:///left',
        writable: true,
      },
      {
        sourceId: 'right-source',
        side: 'right',
        kind: 'file',
        displayName: 'Right',
        rootUri: 'file:///right',
        writable: false,
      },
    ],
  });
  session.registerSnapshot(snapshot('left-source', 'left'));
  session.registerSnapshot(snapshot('right-source', 'right'));
  return session;
}

function snapshot(sourceId: string, side: 'left' | 'right') {
  return {
    snapshotId: `snapshot-${side}`,
    sourceId,
    snapshotRoot: `file:///${side}`,
    origin: `file:///${side}`,
    createdAt: '2026-05-30T10:00:00.000Z',
    retentionUntil: '2026-05-30T12:00:00.000Z',
    sourceRevision: side,
    readOnly: side === 'right',
    cleanupPolicy: 'manual' as const,
    contentHash: side,
  };
}

function requireNodeByLabel(nodes: readonly CompareTreeNode[], label: string): CompareTreeNode {
  const found = collectNodes(nodes, (node) => node.label === label);
  assert.strictEqual(found.length, 1, `Expected exactly one node with label ${label}.`);
  return found[0]!;
}

function collectNodes(
  nodes: readonly CompareTreeNode[],
  predicate: (node: CompareTreeNode) => boolean
): CompareTreeNode[] {
  const found: CompareTreeNode[] = [];
  for (const node of nodes) {
    visit(node, predicate, found);
  }
  return found;
}

function visit(
  node: CompareTreeNode,
  predicate: (node: CompareTreeNode) => boolean,
  found: CompareTreeNode[]
): void {
  if (predicate(node)) {
    found.push(node);
  }
  for (const child of node.children) {
    visit(child, predicate, found);
  }
}
