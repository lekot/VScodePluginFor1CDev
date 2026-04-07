import * as fs from 'fs/promises';
import { getDirective } from './formEventCatalog';

const CRLF = '\r\n';

/**
 * Appends a BSL procedure stub for the given handler to the module file at modulePath.
 *
 * If the file does not exist, it is created with a UTF-8 BOM header.
 * The caller is responsible for collision detection — this function trusts that
 * handlerName is unique within the module.
 *
 * @param modulePath  Absolute path to the .bsl module file.
 * @param handlerName Name of the procedure to create (must be unique).
 * @param eventName   Event name used to determine the BSL compile directive.
 * @returns           1-based line number of the `Процедура handlerName(` declaration.
 */
export async function createHandlerInModule(
    modulePath: string,
    handlerName: string,
    eventName: string
): Promise<{ line: number }> {
    // Step 1: ensure file exists; create with BOM if it does not.
    const fileExists = await fs.access(modulePath).then(() => true, () => false);
    if (!fileExists) {
        await fs.writeFile(modulePath, '\uFEFF', { encoding: 'utf8' });
    }

    // Step 2: read current content.
    const content = await fs.readFile(modulePath, { encoding: 'utf8' });

    // Step 3: build the procedure stub with CRLF line endings.
    const directive = getDirective(eventName);
    const stub =
        CRLF +
        directive + CRLF +
        `Процедура ${handlerName}()` + CRLF +
        `\t// TODO: обработчик события` + CRLF +
        `КонецПроцедуры` + CRLF;

    // Step 4: append stub and write back.
    const combined = content + stub;
    await fs.writeFile(modulePath, combined, { encoding: 'utf8' });

    // Step 5: find the 1-based line number of the procedure declaration.
    const lines = combined.split(/\r?\n/);
    const searchToken = `Процедура ${handlerName}(`;
    const zeroBasedIndex = lines.findIndex(line => line.startsWith(searchToken));
    // zeroBasedIndex should always be >= 0 since we just wrote it; guard with 1 as fallback.
    const lineNumber = zeroBasedIndex >= 0 ? zeroBasedIndex + 1 : 1;

    // Step 6: return line number.
    return { line: lineNumber };
}
