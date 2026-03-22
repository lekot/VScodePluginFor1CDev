import * as fs from 'fs';
import * as path from 'path';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Имя документа-регистратора: явный аргумент или `process.env.IBCMD_RECORDER_DOCUMENT`. */
function resolveRecorderDocumentName(explicit?: string): string {
  const x = explicit?.trim();
  if (x) {
    return x;
  }
  return process.env.IBCMD_RECORDER_DOCUMENT?.trim() || '';
}

/**
 * Дописывает в документ-регистратор ссылку на регистр накопления / сведений в &lt;RegisterRecords&gt;,
 * чтобы ibcmd видел регистратора для регистра с проведением.
 * Без имени документа (env `IBCMD_RECORDER_DOCUMENT` не задан) — no-op.
 */
export async function appendRegisterReferenceToRecorderDocument(
  configRootPath: string,
  registerKind: 'AccumulationRegister' | 'InformationRegister',
  registerName: string,
  recorderDocumentName?: string
): Promise<void> {
  const docName = resolveRecorderDocumentName(recorderDocumentName);
  if (!docName) {
    return;
  }
  const docPath = path.join(configRootPath, 'Documents', `${docName}.xml`);
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
  recorderDocumentName?: string
): Promise<void> {
  const docName = resolveRecorderDocumentName(recorderDocumentName);
  if (!docName) {
    return;
  }
  const docPath = path.join(configRootPath, 'Documents', `${docName}.xml`);
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
