// src/agent/agentOperations.ts
// Agent API — бизнес-логика без зависимостей от vscode.
// Используется как из agentCommands.ts (VS Code), так и из unit-тестов (mocha).

import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { rulesRegistry, metadataConverter } from '../rules';
import { addRootObjectToConfiguration } from '../services/configurationXmlUpdater';
import { injectInternalInfoIntoMetadataXml } from '../utils/xml/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../utils/xml/metaDataObjectRootNormalizer';
import { generateSimpleUuid } from '../utils/xml/xmlHelpers';
import { CONFIGURATION_XML } from '../constants/fileNames';
import type {
    AgentResult,
    CreateObjectParams,
    GetYamlParams,
    ListObjectsParams,
    ObjectInfo,
} from './types';

// ─── XML-парсер для Configuration.xml (без preserveOrder — нам нужен простой доступ) ───

const configParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
});

// ─── AgentOperations ────────────────────────────────────────────────────────

export class AgentOperations {
    private readonly configRootPath: string;

    constructor(configRootPath: string) {
        this.configRootPath = configRootPath;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // createObject
    // ─────────────────────────────────────────────────────────────────────────

    async createObject(params: CreateObjectParams): Promise<AgentResult<{ filePath: string }>> {
        try {
            const { type, name, synonym, properties } = params;

            // Валидация
            if (!type || typeof type !== 'string') {
                return { success: false, error: 'Параметр type обязателен и должен быть строкой.' };
            }
            if (!name || typeof name !== 'string' || !name.trim()) {
                return { success: false, error: 'Параметр name обязателен и не может быть пустым.' };
            }
            const trimmedName = name.trim();

            // Проверяем наличие правил
            const rules = rulesRegistry.get(type);
            if (!rules) {
                return {
                    success: false,
                    error: `Тип "${type}" не поддерживается. Доступные типы: ${rulesRegistry.allRootTags().join(', ')}`,
                };
            }

            // Определяем папку типа (мн. число = rootTag + 's')
            const typeFolderName = `${type}s`;
            const typeFolderPath = path.join(this.configRootPath, typeFolderName);
            await fs.promises.mkdir(typeFolderPath, { recursive: true });

            const newFilePath = path.join(typeFolderPath, `${trimmedName}.xml`);

            // Проверяем, что файл не существует
            try {
                await fs.promises.access(newFilePath);
                return { success: false, error: `Объект уже существует: ${newFilePath}` };
            } catch {
                // ENOENT — файл не существует, продолжаем
            }

            // Создаём IR с дефолтными значениями
            const uuid = generateSimpleUuid();
            let ir = metadataConverter.createDefaultIR(rules, { name: trimmedName, uuid });

            // Применяем synonym как override через properties
            const overrides: Record<string, unknown> = {};
            if (synonym !== undefined) {
                overrides['Synonym'] = synonym;
            }
            if (properties) {
                Object.assign(overrides, properties);
            }
            if (Object.keys(overrides).length > 0) {
                ir = metadataConverter.mergeProperties(ir, overrides);
            }

            // Генерируем XML
            let content = metadataConverter.irToXml(ir, rules);
            content = injectInternalInfoIntoMetadataXml(content, type, trimmedName);
            content = normalizeMetaDataObjectRoot(content);

            await fs.promises.writeFile(newFilePath, content, 'utf-8');

            // Создаём директорию объекта
            const elementDir = path.join(typeFolderPath, trimmedName);
            await fs.promises.mkdir(elementDir, { recursive: true });

            // Регистрируем в Configuration.xml
            await addRootObjectToConfiguration(this.configRootPath, type, trimmedName);

            return { success: true, data: { filePath: newFilePath } };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getYaml
    // ─────────────────────────────────────────────────────────────────────────

    async getYaml(params: GetYamlParams): Promise<AgentResult<{ yaml: string }>> {
        try {
            const { path: objectPath } = params;

            if (!objectPath || typeof objectPath !== 'string') {
                return { success: false, error: 'Параметр path обязателен.' };
            }

            // Парсим путь вида 'Catalog.Товары'
            const dotIdx = objectPath.indexOf('.');
            if (dotIdx === -1) {
                return { success: false, error: 'Параметр path должен быть вида "Тип.Имя", например "Catalog.Товары".' };
            }
            const type = objectPath.slice(0, dotIdx);
            const name = objectPath.slice(dotIdx + 1);

            if (!type || !name) {
                return { success: false, error: 'Некорректный путь: тип или имя объекта пустые.' };
            }

            const rules = rulesRegistry.get(type);
            if (!rules) {
                return {
                    success: false,
                    error: `Тип "${type}" не поддерживается Rules Engine. Доступные типы: ${rulesRegistry.allRootTags().join(', ')}`,
                };
            }

            // Ищем XML-файл
            const typeFolderName = `${type}s`;
            const xmlFilePath = path.join(this.configRootPath, typeFolderName, `${name}.xml`);

            let xmlContent: string;
            try {
                xmlContent = await fs.promises.readFile(xmlFilePath, 'utf-8');
            } catch {
                return { success: false, error: `XML-файл не найден: ${xmlFilePath}` };
            }

            const ir = metadataConverter.xmlToIr(xmlContent, rules);
            const yaml = metadataConverter.irToYaml(ir, rules);

            return { success: true, data: { yaml } };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // listObjects
    // ─────────────────────────────────────────────────────────────────────────

    async listObjects(params: ListObjectsParams): Promise<AgentResult<{ objects: ObjectInfo[] }>> {
        try {
            const configPath = path.join(this.configRootPath, CONFIGURATION_XML);

            let xmlContent: string;
            try {
                xmlContent = await fs.promises.readFile(configPath, 'utf-8');
            } catch {
                return { success: false, error: `Configuration.xml не найден: ${configPath}` };
            }

            let parsed: unknown;
            try {
                parsed = configParser.parse(xmlContent);
            } catch (parseErr) {
                return {
                    success: false,
                    error: `Ошибка парсинга Configuration.xml: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
                };
            }

            // Извлекаем ChildObjects
            const childObjects = extractChildObjects(parsed);
            if (!childObjects) {
                return { success: true, data: { objects: [] } };
            }

            const filterType = params.type;
            const objects: ObjectInfo[] = [];

            for (const [tagName, names] of Object.entries(childObjects)) {
                if (filterType && tagName !== filterType) {
                    continue;
                }
                const nameList = Array.isArray(names) ? names : [names];
                for (const nameEntry of nameList) {
                    const objectName = typeof nameEntry === 'string'
                        ? nameEntry
                        : (nameEntry as Record<string, unknown>)['#text'] as string ?? String(nameEntry);
                    if (!objectName) {continue;}

                    const typeFolderName = `${tagName}s`;
                    const filePath = path.join(this.configRootPath, typeFolderName, `${objectName}.xml`);
                    objects.push({ type: tagName, name: objectName, filePath });
                }
            }

            return { success: true, data: { objects } };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
}

// ─── Хелпер: извлечь ChildObjects из распарсенного Configuration.xml ────────

function extractChildObjects(parsed: unknown): Record<string, unknown> | null {
    if (!parsed || typeof parsed !== 'object') {return null;}
    const root = parsed as Record<string, unknown>;

    // Структура: { MetaDataObject: { Configuration: { ChildObjects: { Catalog: [...], ... } } } }
    const metaDataObject = root['MetaDataObject'];
    if (!metaDataObject || typeof metaDataObject !== 'object') {return null;}

    const configuration = (metaDataObject as Record<string, unknown>)['Configuration'];
    if (!configuration || typeof configuration !== 'object') {return null;}

    const childObjects = (configuration as Record<string, unknown>)['ChildObjects'];
    if (!childObjects || typeof childObjects !== 'object' || Array.isArray(childObjects)) {
        return null;
    }
    return childObjects as Record<string, unknown>;
}
