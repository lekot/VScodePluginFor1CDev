import * as assert from 'assert';

import type { BslModuleDiagnostic, BslModuleIdentity } from '../../../src/compareMerge/bsl/bslModuleIndexer';
import {
  selectBslSourceRetention,
  type ResolvedBslInventoryFile,
} from '../../../src/compareMerge/bsl/bslSourceRetention';

suite('BSL source retention', () => {
  test('retains every path for cross-side module identities and only exact matched right Form modules', () => {
    const left = [
      supported('/left/shared-first.bsl', 'CommonModule.Shared', 'CommonModule', 'Shared'),
      supported('/left/shared-second.bsl', 'CommonModule.Shared', 'CommonModule', 'Shared'),
      supported('/left/left-only.bsl', 'CommonModule.LeftOnly', 'CommonModule', 'LeftOnly'),
      unsupported('/left/unrecognized.bsl', 'left'),
    ];
    const right = [
      supported('/right/shared-first.bsl', 'CommonModule.Shared', 'CommonModule', 'Shared'),
      supported('/right/shared-second.bsl', 'CommonModule.Shared', 'CommonModule', 'Shared'),
      supported('/right/matched-form.bsl', 'Catalog.Products.Form.Main.FormModule', 'Form', 'Products', 'Main'),
      supported('/right/unmatched-form.bsl', 'Catalog.Products.Form.Other.FormModule', 'Form', 'Products', 'Other'),
      supported('/right/right-only.bsl', 'CommonModule.RightOnly', 'CommonModule', 'RightOnly'),
      unsupported('/right/unrecognized.bsl', 'right'),
    ];

    const retention = selectBslSourceRetention({
      left,
      right,
      matchedFormModuleIds: new Set(['Catalog.Products.Form.Main.FormModule']),
    });

    assert.deepStrictEqual([...retention.leftPaths].sort(), [
      '/left/shared-first.bsl',
      '/left/shared-second.bsl',
    ]);
    assert.deepStrictEqual([...retention.rightPaths].sort(), [
      '/right/matched-form.bsl',
      '/right/shared-first.bsl',
      '/right/shared-second.bsl',
    ]);
  });
});

function supported(
  filePath: string,
  moduleId: string,
  moduleKind: BslModuleIdentity['moduleKind'],
  objectName: string,
  formName?: string
): ResolvedBslInventoryFile {
  return {
    filePath,
    identity: {
      sourceId: filePath.startsWith('/left') ? 'left-source' : 'right-source',
      side: filePath.startsWith('/left') ? 'left' : 'right',
      filePath,
      configRoot: pathRoot(filePath),
      metadataType: moduleKind === 'CommonModule' ? 'CommonModule' : 'Catalog',
      objectName,
      moduleKind,
      moduleId,
      displayName: moduleId,
      ...(formName ? { formName } : {}),
    },
  };
}

function unsupported(filePath: string, side: 'left' | 'right'): ResolvedBslInventoryFile {
  const diagnostic: BslModuleDiagnostic = {
    severity: 'warning',
    code: 'BSL_MODULE_UNSUPPORTED_PATH',
    blocking: false,
    message: 'Unsupported path.',
    sourceId: `${side}-source`,
    side,
    filePath,
  };
  return { filePath, diagnostic };
}

function pathRoot(filePath: string): string {
  return filePath.startsWith('/left') ? '/left' : '/right';
}
