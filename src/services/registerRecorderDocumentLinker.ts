import * as fs from 'fs';
import * as path from 'path';
import { getRecorderDocumentNameForTemplates } from '../constants/ibcmdFixtureRefs';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Дописывает в документ-регистратор ссылку на регистр накопления / сведений в &lt;RegisterRecords&gt;,
 * чтобы ibcmd видел регистратора для регистра с проведением.
 */
export async function appendRegisterReferenceToRecorderDocument(
  configRootPath: string,
  registerKind: 'AccumulationRegister' | 'InformationRegister',
  registerName: string,
  recorderDocumentName: string = getRecorderDocumentNameForTemplates()
): Promise<void> {
  const docPath = path.join(configRootPath, 'Documents', `${recorderDocumentName}.xml`);
  if (!fs.existsSync(docPath)) {
    return;
  }
  const ref = `${registerKind}.${registerName}`;
  let xml = await fs.promises.readFile(docPath, 'utf-8');
  if (xml.includes(ref)) {
    return;
  }
  const itemLine = `\t\t\t<xr:Item xsi:type="xr:MDObjectRef">${ref}</xr:Item>`;
  if (xml.includes('<RegisterRecords/>')) {
    xml = xml.replace(
      '<RegisterRecords/>',
      `<RegisterRecords>\n${itemLine}\n\t\t</RegisterRecords>`
    );
  } else if (xml.includes('</RegisterRecords>')) {
    xml = xml.replace('</RegisterRecords>', `${itemLine}\n\t\t</RegisterRecords>`);
  } else {
    return;
  }
  await fs.promises.writeFile(docPath, xml, 'utf-8');
}

/**
 * Удаляет из документа-регистратора ссылку на регистр (симметрично {@link appendRegisterReferenceToRecorderDocument}).
 * Нужно при удалении регистра, иначе в &lt;RegisterRecords&gt; остаётся ссылка на несуществующий объект (ibcmd: «Неизвестный объект метаданных»).
 */
export async function removeRegisterReferenceFromRecorderDocument(
  configRootPath: string,
  registerKind: 'AccumulationRegister' | 'InformationRegister',
  registerName: string,
  recorderDocumentName: string = getRecorderDocumentNameForTemplates()
): Promise<void> {
  const docPath = path.join(configRootPath, 'Documents', `${recorderDocumentName}.xml`);
  if (!fs.existsSync(docPath)) {
    return;
  }
  const ref = `${registerKind}.${registerName}`;
  let xml = await fs.promises.readFile(docPath, 'utf-8');
  if (!xml.includes(ref)) {
    return;
  }
  const itemRe = new RegExp(
    '\\s*<xr:Item[^>]*>\\s*' + escapeRegex(ref) + '\\s*</xr:Item>',
    'g'
  );
  xml = xml.replace(itemRe, '');
  xml = xml.replace(/<RegisterRecords>\s*<\/RegisterRecords>/g, '<RegisterRecords/>');
  await fs.promises.writeFile(docPath, xml, 'utf-8');
}
