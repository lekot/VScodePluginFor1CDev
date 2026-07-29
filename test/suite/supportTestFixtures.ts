import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import {
  ParentConfigurationsCodec,
  type ParsedParentConfigurations,
} from '../../src/support/parentConfigurationsCodec';

export const SUPPORT_TEST_CONFIGURATION_ID = 'support-test-configuration' as ConfigurationId;

export const SUPPORT_UUIDS = {
  supplierA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  supplierB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  parentA: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  parentB: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  objectA: '11111111-1111-4111-8111-111111111111',
  objectB: '22222222-2222-4222-8222-222222222222',
  objectC: '33333333-3333-4333-8333-333333333333',
  vendorA: '44444444-4444-4444-8444-444444444444',
  vendorB: '55555555-5555-4555-8555-555555555555',
  vendorC: '66666666-6666-4666-8666-666666666666',
} as const;

export interface SyntheticObjectRule {
  readonly mode: '0' | '1' | '2';
  readonly secondaryFlag?: string;
  readonly localUuid: string;
  readonly vendorUuid: string;
}

export interface SyntheticSupplier {
  readonly supplierId: string;
  readonly blockFlag?: string;
  readonly parentId: string;
  readonly version?: string;
  readonly vendor?: string;
  readonly name?: string;
  readonly objects: readonly SyntheticObjectRule[];
  readonly footer?: readonly [string, string];
}

export interface SyntheticParentConfigurationsOptions {
  readonly revision?: string;
  readonly globalFlag?: string;
  readonly suppliers?: readonly SyntheticSupplier[];
  readonly tail?: readonly string[];
  readonly bom?: boolean;
  readonly separator?: string;
}

const DEFAULT_TAIL = ['0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0'] as const;

export function syntheticSupplier(
  overrides: Partial<SyntheticSupplier> = {},
): SyntheticSupplier {
  return {
    supplierId: SUPPORT_UUIDS.supplierA,
    blockFlag: '0',
    parentId: SUPPORT_UUIDS.parentA,
    version: '1.0',
    vendor: 'Synthetic Vendor',
    name: 'Synthetic Parent',
    objects: [{
      mode: '0',
      localUuid: SUPPORT_UUIDS.objectA,
      vendorUuid: SUPPORT_UUIDS.vendorA,
    }],
    footer: ['0', '0'],
    ...overrides,
  };
}

export function buildParentConfigurations(
  options: SyntheticParentConfigurationsOptions = {},
): Buffer {
  const suppliers = options.suppliers ?? [syntheticSupplier()];
  const tokens: string[] = [
    options.revision ?? '6',
    options.globalFlag ?? '0',
    String(suppliers.length),
  ];
  for (const supplier of suppliers) {
    tokens.push(
      supplier.supplierId,
      supplier.blockFlag ?? '0',
      supplier.parentId,
      quote(supplier.version ?? '1.0'),
      quote(supplier.vendor ?? 'Synthetic Vendor'),
      quote(supplier.name ?? 'Synthetic Parent'),
      String(supplier.objects.length),
    );
    for (const object of supplier.objects) {
      tokens.push(
        object.mode,
        object.secondaryFlag ?? '0',
        object.localUuid,
        object.vendorUuid,
      );
    }
    tokens.push(...(supplier.footer ?? ['0', '0']));
  }
  tokens.push(...(options.tail ?? DEFAULT_TAIL));
  const body = `{${tokens.join(options.separator ?? ',')}}`;
  return Buffer.concat([
    ...(options.bom ? [Buffer.from([0xef, 0xbb, 0xbf])] : []),
    Buffer.from(body, 'utf8'),
  ]);
}

export function parseReadyDocument(
  bytes: Uint8Array,
  configRoot = path.resolve('synthetic-support-root'),
): ParsedParentConfigurations {
  const filePath = path.join(configRoot, 'Ext', 'ParentConfigurations.bin');
  const document = ParentConfigurationsCodec.parse(bytes, {
    configurationId: SUPPORT_TEST_CONFIGURATION_ID,
    filePath,
    configRoot,
  });
  if (document.state.kind !== 'ready') {
    const detail = document.state.kind === 'unknown'
      ? document.state.diagnostics.join(' ')
      : document.state.reason;
    throw new Error(`Expected ready synthetic master: ${detail}`);
  }
  return document;
}

export async function writeSyntheticMaster(configRoot: string, bytes: Uint8Array): Promise<string> {
  const filePath = path.join(configRoot, 'Ext', 'ParentConfigurations.bin');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  return filePath;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
