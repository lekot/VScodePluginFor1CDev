import * as assert from 'assert';
import {
  isValidWebviewMessage,
  WebviewMessage,
  ExtensionToWebviewMessage,
  LoadPhase,
  SearchState,
} from '../../src/rolesEditor/models/webviewMessage';
import { MetadataObject } from '../../src/rolesEditor/models/metadataObject';
import { MetadataType } from '../../src/models/treeNode';

suite('RolesEditor Loading Protocol Contract', () => {
  suite('isValidWebviewMessage', () => {
    test('accepts all valid webview commands with valid data', () => {
      const validMessages: WebviewMessage[] = [
        { command: 'updateRight', data: { objectName: 'Catalog.Товары', rightType: 'read', value: true } },
        { command: 'save', data: { restrictionTemplatesText: '<templates/>' } },
        { command: 'savePayload', data: { requestId: 'req-1', restrictionTemplatesText: '' } },
        { command: 'cancel' },
        { command: 'toggleFilter', data: { showAll: true } },
        { command: 'search', data: { sessionId: 'sess-1', queryId: 1, query: 'Артикул' } },
        { command: 'cancelSearch', data: { sessionId: 'sess-1', queryId: 1 } },
        { command: 'filterByType', data: { type: 'Catalog' } },
        {
          command: 'tableRenderProgress',
          data: { sessionId: 'sess-1', dataRevision: 2, busy: false, rowCount: 150, firstTableReady: true },
        },
        {
          command: 'loadObjectAttributes',
          data: { sessionId: 'sess-1', requestId: 'attr-req-1', objectFullName: 'Catalog.Номенклатура' },
        },
      ];

      for (const msg of validMessages) {
        assert.strictEqual(
          isValidWebviewMessage(msg),
          true,
          `Expected valid message for command: ${msg.command}`
        );
      }
    });

    test('rejects non-object and null messages', () => {
      assert.strictEqual(isValidWebviewMessage(null), false);
      assert.strictEqual(isValidWebviewMessage(undefined), false);
      assert.strictEqual(isValidWebviewMessage('command'), false);
      assert.strictEqual(isValidWebviewMessage(123), false);
      assert.strictEqual(isValidWebviewMessage([]), false);
    });

    test('rejects messages without command or with unknown command', () => {
      assert.strictEqual(isValidWebviewMessage({}), false);
      assert.strictEqual(isValidWebviewMessage({ command: '' }), false);
      assert.strictEqual(isValidWebviewMessage({ command: 'unknownCommand' }), false);
      assert.strictEqual(isValidWebviewMessage({ command: 'hack' }), false);
      assert.strictEqual(isValidWebviewMessage({ command: 42 }), false);
    });

    test('rejects messages with non-object data', () => {
      assert.strictEqual(
        isValidWebviewMessage({ command: 'updateRight', data: 'invalid' as unknown as object }),
        false
      );
      assert.strictEqual(
        isValidWebviewMessage({ command: 'save', data: 123 as unknown as object }),
        false
      );
    });
  });

  suite('ExtensionToWebviewMessage Contract', () => {
    test('supports staged objectsLoaded payload with correlation and phase', () => {
      const initialPhase: LoadPhase = 'initial';
      const indexPhase: LoadPhase = 'index';
      const completePhase: LoadPhase = 'complete';

      const obj: MetadataObject = {
        fullName: 'Catalog.Товары',
        type: MetadataType.Catalog,
        name: 'Товары',
        displayName: 'Товары (Synonym)',
        hasRights: true,
        attributesState: 'notLoaded',
      };

      const initialMessage: ExtensionToWebviewMessage = {
        command: 'objectsLoaded',
        data: {
          sessionId: 'session-uuid-1',
          dataRevision: 1,
          phase: initialPhase,
          isIndexComplete: false,
          objects: [obj],
        },
      };

      assert.strictEqual(initialMessage.command, 'objectsLoaded');
      assert.strictEqual(initialMessage.data.phase, 'initial');
      assert.strictEqual(initialMessage.data.sessionId, 'session-uuid-1');
      assert.strictEqual(initialMessage.data.dataRevision, 1);
      assert.strictEqual(initialMessage.data.isIndexComplete, false);
      assert.strictEqual(initialMessage.data.objects.length, 1);
      assert.strictEqual(initialMessage.data.objects[0].attributesState, 'notLoaded');

      const indexMessage: ExtensionToWebviewMessage = {
        command: 'objectsLoaded',
        data: {
          sessionId: 'session-uuid-1',
          dataRevision: 2,
          phase: indexPhase,
          isIndexComplete: true,
          objects: [obj],
        },
      };
      assert.strictEqual(indexMessage.data.phase, 'index');
      assert.strictEqual(indexMessage.data.isIndexComplete, true);
    });

    test('supports loadObjectAttributesResult with loaded and failed states', () => {
      const attrRow: MetadataObject = {
        fullName: 'Catalog.Товары.Attribute.Артикул',
        type: MetadataType.Attribute,
        name: 'Артикул',
        displayName: 'Артикул',
        hasRights: false,
        rowKind: 'attribute',
        parentLabel: 'Товары (Catalog)',
      };

      const successResult: ExtensionToWebviewMessage = {
        command: 'loadObjectAttributesResult',
        data: {
          sessionId: 'session-uuid-1',
          requestId: 'req-attr-1',
          objectFullName: 'Catalog.Товары',
          state: 'loaded',
          attributes: [attrRow],
        },
      };

      assert.strictEqual(successResult.command, 'loadObjectAttributesResult');
      assert.strictEqual(successResult.data.state, 'loaded');
      assert.strictEqual(successResult.data.attributes.length, 1);
      assert.strictEqual(successResult.data.attributes[0].name, 'Артикул');

      const failedResult: ExtensionToWebviewMessage = {
        command: 'loadObjectAttributesResult',
        data: {
          sessionId: 'session-uuid-1',
          requestId: 'req-attr-2',
          objectFullName: 'Catalog.Недоступный',
          state: 'failed',
          attributes: [],
          error: 'XML read permission denied or file missing',
        },
      };

      assert.strictEqual(failedResult.data.state, 'failed');
      assert.strictEqual(failedResult.data.attributes.length, 0);
      assert.ok(failedResult.data.error?.includes('permission denied'));
    });

    test('supports searchProgress with state progression and cancellation', () => {
      const states: SearchState[] = ['idle', 'running', 'complete', 'incomplete', 'cancelled'];
      for (const state of states) {
        const progressMessage: ExtensionToWebviewMessage = {
          command: 'searchProgress',
          data: {
            sessionId: 'session-uuid-1',
            queryId: 42,
            state,
            processed: 50,
            total: 100,
            matchingObjectNames: ['Catalog.Товары'],
          },
        };

        assert.strictEqual(progressMessage.command, 'searchProgress');
        assert.strictEqual(progressMessage.data.state, state);
        assert.strictEqual(progressMessage.data.queryId, 42);
      }
    });
  });

  suite('Session and Query Correlation Invariants', () => {
    test('drops responses when session identifier does not match active session', () => {
      let activeSessionId = 'active-session-1';
      const receivedMessages: ExtensionToWebviewMessage[] = [];

      function acceptIfCurrentSession(msg: ExtensionToWebviewMessage): boolean {
        if (msg.data && 'sessionId' in msg.data && msg.data.sessionId && msg.data.sessionId !== activeSessionId) {
          return false;
        }
        receivedMessages.push(msg);
        return true;
      }

      const msgOldSession: ExtensionToWebviewMessage = {
        command: 'loadObjectAttributesResult',
        data: {
          sessionId: 'stale-session-0',
          requestId: 'req-1',
          objectFullName: 'Catalog.Old',
          state: 'loaded',
          attributes: [],
        },
      };

      const msgCurrentSession: ExtensionToWebviewMessage = {
        command: 'loadObjectAttributesResult',
        data: {
          sessionId: 'active-session-1',
          requestId: 'req-2',
          objectFullName: 'Catalog.New',
          state: 'loaded',
          attributes: [],
        },
      };

      assert.strictEqual(acceptIfCurrentSession(msgOldSession), false);
      assert.strictEqual(acceptIfCurrentSession(msgCurrentSession), true);
      assert.strictEqual(receivedMessages.length, 1);
      const first = receivedMessages[0];
      assert.strictEqual(first.command, 'loadObjectAttributesResult');
      if (first.command === 'loadObjectAttributesResult') {
        assert.strictEqual(first.data.sessionId, 'active-session-1');
      }
    });

    test('drops search progress when query generation is stale', () => {
      let activeQueryId = 5;
      const progressUpdates: number[] = [];

      function acceptSearchProgress(queryId: number): boolean {
        if (queryId < activeQueryId) {
          return false;
        }
        progressUpdates.push(queryId);
        return true;
      }

      assert.strictEqual(acceptSearchProgress(3), false, 'Old query result must be rejected');
      assert.strictEqual(acceptSearchProgress(4), false, 'Old query result must be rejected');
      assert.strictEqual(acceptSearchProgress(5), true, 'Current query result must be accepted');
      activeQueryId = 6;
      assert.strictEqual(acceptSearchProgress(5), false, 'Previously current result now stale must be rejected');
      assert.strictEqual(acceptSearchProgress(6), true, 'New current query result accepted');
      assert.deepStrictEqual(progressUpdates, [5, 6]);
    });
  });
});
