// src/agent/agentSkdOperations.ts
// Agent SKD API — реализация операций над СКД (Система Компоновки Данных 1С).
// Каждая операция запускает соответствующий PS1-скрипт через PowerShell runner.

import * as path from 'path';
import type * as vscode from 'vscode';
import type { AgentResult } from './types';
import type {
    SkdCompileParams,
    SkdCompileResult,
    SkdInfoParams,
    SkdInfoResult,
    SkdEditParams,
    SkdEditResult,
    SkdValidateParams,
    SkdValidateResult,
    SkdOperationInDoubtResult,
} from './agentSkdTypes';
import { runPowerShellScript } from '../services/skd/powershellRunner';
import { createProcessOutputLineReporter } from '../services/process/processOutputLineReporter';
import { assertPathWithinRoot } from '../services/configurationSession/pathBoundary';
import {
    mapSkdPathError,
    resolveSkdExistingFile,
    resolveSkdOutputPath,
    resolveSkdReportPath,
    resolveSkdTemplatePath,
} from './skdPathResolver';

// ─── SkdOperations ────────────────────────────────────────────────────────────

export interface SkdOperationsDeps {
    /** Путь к корню расширения (context.extensionPath). */
    extensionPath: string;
    /** Корень конфигурации для валидации границ путей. */
    configRoot?: string;
    /** Injectable process boundary for tests and host integrations. */
    runPowerShellScript?: typeof runPowerShellScript;
    /** Injectable path validator (defaults to assertPathWithinRoot). */
    assertPathWithinRoot?: typeof assertPathWithinRoot;
}

/** Класс операций Agent SKD API. Инстанциируется при каждом вызове команды. */
export class SkdOperations {
    constructor(private readonly deps: SkdOperationsDeps) {}

    private pathFailure(error: unknown, targetPath: string): AgentResult<never> {
        const failure = mapSkdPathError(error, targetPath);
        return { success: false, code: failure.code, error: failure.message };
    }

    private async resolveTemplatePath(
        targetPath: string,
        allowObjectDiscovery: boolean,
        allowLegacyExtFallback = false,
    ): Promise<{ readonly path?: string; readonly failure?: AgentResult<never> }> {
        if (!this.deps.configRoot) { return { path: targetPath }; }
        try {
            const validator = this.deps.assertPathWithinRoot ?? assertPathWithinRoot;
            return { path: await resolveSkdTemplatePath(this.deps.configRoot, targetPath, allowObjectDiscovery, validator, allowLegacyExtFallback) };
        } catch (error) {
            return { failure: this.pathFailure(error, targetPath) };
        }
    }

    private async resolveExistingFile(targetPath: string): Promise<{ readonly path?: string; readonly failure?: AgentResult<never> }> {
        if (!this.deps.configRoot) { return { path: targetPath }; }
        try {
            const validator = this.deps.assertPathWithinRoot ?? assertPathWithinRoot;
            return { path: await resolveSkdExistingFile(this.deps.configRoot, targetPath, validator) };
        } catch (error) {
            return { failure: this.pathFailure(error, targetPath) };
        }
    }

    private async resolveOutputPath(targetPath: string): Promise<{ readonly path?: string; readonly failure?: AgentResult<never> }> {
        if (!this.deps.configRoot) { return { path: targetPath }; }
        try {
            const validator = this.deps.assertPathWithinRoot ?? assertPathWithinRoot;
            return { path: await resolveSkdOutputPath(this.deps.configRoot, targetPath, validator) };
        } catch (error) {
            return { failure: this.pathFailure(error, targetPath) };
        }
    }

    private async resolveReportPath(
        targetPath: string,
        effectiveInput: string,
    ): Promise<{ readonly path?: string; readonly failure?: AgentResult<never> }> {
        if (!this.deps.configRoot) { return { path: targetPath }; }
        try {
            const validator = this.deps.assertPathWithinRoot ?? assertPathWithinRoot;
            return { path: await resolveSkdReportPath(this.deps.configRoot, targetPath, effectiveInput, validator) };
        } catch (error) {
            return { failure: this.pathFailure(error, targetPath) };
        }
    }

    private async runScript(
        opts: Parameters<typeof runPowerShellScript>[0],
        reportStage?: (message: string) => void,
    ): ReturnType<typeof runPowerShellScript> {
        const output = createProcessOutputLineReporter(reportStage);
        try {
            return await (this.deps.runPowerShellScript ?? runPowerShellScript)({
                ...opts,
                onOutput: output.accept,
            });
        } finally {
            output.flush();
        }
    }

    // ─── skd.compile ─────────────────────────────────────────────────────────

    /**
     * Компилирует JSON DSL СКД в XML (Template.xml).
     * Использует skd-compile.ps1 (-DefinitionFile/-Value, -OutputPath).
     */
    async skdCompile(
        params: SkdCompileParams,
        token?: vscode.CancellationToken,
        reportStage?: (message: string) => void,
    ): Promise<AgentResult<SkdCompileResult | SkdOperationInDoubtResult>> {
        const stopped = cancellationFailure(token);
        if (stopped) { return stopped; }
        if (!params.outputPath) {
            return { success: false, error: 'параметр outputPath обязателен' };
        }
        if (!params.definitionFile && !params.value) {
            return { success: false, error: 'обязателен один из параметров: definitionFile или value' };
        }
        if (params.definitionFile && params.value) {
            return { success: false, error: 'нельзя использовать оба параметра definitionFile и value одновременно' };
        }

        const resolvedOutput = await this.resolveOutputPath(params.outputPath);
        if (resolvedOutput.failure) { return resolvedOutput.failure; }
        const outputPath = resolvedOutput.path!;
        let definitionFile = params.definitionFile;
        if (definitionFile) {
            const resolvedDefinition = await this.resolveExistingFile(definitionFile);
            if (resolvedDefinition.failure) { return resolvedDefinition.failure; }
            definitionFile = resolvedDefinition.path!;
        }

        const scriptPath = path.join(this.deps.extensionPath, 'resources', 'skd', 'skd-compile.ps1');
        const args: string[] = [];

        if (definitionFile) {
            args.push('-DefinitionFile', definitionFile);
        } else if (params.value) {
            args.push('-Value', params.value);
        }
        args.push('-OutputPath', outputPath);

        reportStage?.('Компиляция СКД через PowerShell.');
        const result = await this.runScript({ scriptPath, args, token }, reportStage);

        const cancelled = processCancellationFailure(result);
        if (cancelled) { return cancelled; }
        const truncatedOutput = successfulOutputTruncationFailure(result);
        if (truncatedOutput) { return truncatedOutput; }

        if (result.exitCode !== 0) {
            const errMsg = result.stderr.trim() || result.stdout.trim() || `skd-compile failed with exit code ${result.exitCode}`;
            return { success: false, error: errMsg };
        }

        // Parse stats from stdout:
        // Line 1: "OK  {path}"
        // Line 2: "    DataSets: N  Fields: N  Calculated: N  Totals: N  Params: N  Variants: N"
        // Line 3: "    Size: N bytes"
        const lines = result.stdout.trim().split(/\r?\n/);
        const reportedOutputPath = parseCompileOutputPath(lines[0] ?? '');
        const stats = parseCompileStats(lines[1] ?? '', lines[2] ?? '');

        return {
            success: true,
            data: {
                output: reportedOutputPath || outputPath,
                stats,
                rawOutput: result.stdout,
            },
        };
    }

    // ─── skd.info ─────────────────────────────────────────────────────────────

    /**
     * Анализирует структуру СКД и возвращает plain-text отчёт.
     * Использует skd-info.ps1 (-TemplatePath, -Mode, и др.).
     */
    async skdInfo(
        params: SkdInfoParams,
        token?: vscode.CancellationToken,
        reportStage?: (message: string) => void,
    ): Promise<AgentResult<SkdInfoResult | SkdOperationInDoubtResult>> {
        const stopped = cancellationFailure(token);
        if (stopped) { return stopped; }
        if (!params.templatePath) {
            return { success: false, error: 'параметр templatePath обязателен' };
        }

        const resolvedTemplate = await this.resolveTemplatePath(params.templatePath, true);
        if (resolvedTemplate.failure) { return resolvedTemplate.failure; }
        const templatePath = resolvedTemplate.path!;
        let outFile = params.outFile;
        if (outFile) {
            const resolvedReport = await this.resolveReportPath(outFile, templatePath);
            if (resolvedReport.failure) { return resolvedReport.failure; }
            outFile = resolvedReport.path!;
        }

        const scriptPath = path.join(this.deps.extensionPath, 'resources', 'skd', 'skd-info.ps1');
        const args: string[] = ['-TemplatePath', templatePath];

        if (params.mode) {
            args.push('-Mode', params.mode);
        }
        if (params.name) {
            args.push('-Name', params.name);
        }
        if (params.batch !== undefined) {
            args.push('-Batch', String(params.batch));
        }
        if (params.limit !== undefined) {
            args.push('-Limit', String(params.limit));
        }
        if (params.offset !== undefined) {
            args.push('-Offset', String(params.offset));
        }
        if (outFile) {
            args.push('-OutFile', outFile);
        }

        reportStage?.('Получение сведений о СКД через PowerShell.');
        const result = await this.runScript({ scriptPath, args, token }, reportStage);

        const cancelled = processCancellationFailure(result);
        if (cancelled) { return cancelled; }
        const truncatedOutput = successfulOutputTruncationFailure(result);
        if (truncatedOutput) { return truncatedOutput; }

        if (result.exitCode !== 0) {
            const errMsg = result.stderr.trim() || result.stdout.trim() || `skd-info failed with exit code ${result.exitCode}`;
            return { success: false, error: errMsg };
        }

        const truncated = result.stdout.includes('[TRUNCATED]');

        return {
            success: true,
            data: {
                info: result.stdout,
                truncated,
            },
        };
    }

    // ─── skd.edit ─────────────────────────────────────────────────────────────

    /**
     * Атомарное редактирование СКД.
     * Использует skd-edit.ps1 (-TemplatePath, -Operation, -Value, и др.).
     */
    async skdEdit(
        params: SkdEditParams,
        token?: vscode.CancellationToken,
        reportStage?: (message: string) => void,
    ): Promise<AgentResult<SkdEditResult | SkdOperationInDoubtResult>> {
        const stopped = cancellationFailure(token);
        if (stopped) { return stopped; }
        if (!params.templatePath) {
            return { success: false, error: 'параметр templatePath обязателен' };
        }
        if (!params.operation) {
            return { success: false, error: 'параметр operation обязателен' };
        }
        if (params.value === undefined || params.value === null) {
            return { success: false, error: 'параметр value обязателен' };
        }

        const resolvedTemplate = await this.resolveTemplatePath(params.templatePath, false);
        if (resolvedTemplate.failure) { return resolvedTemplate.failure; }
        const templatePath = resolvedTemplate.path!;

        const scriptPath = path.join(this.deps.extensionPath, 'resources', 'skd', 'skd-edit.ps1');
        const args: string[] = [
            '-TemplatePath', templatePath,
            '-Operation', params.operation,
            '-Value', params.value,
        ];

        if (params.dataSet) {
            args.push('-DataSet', params.dataSet);
        }
        if (params.variant) {
            args.push('-Variant', params.variant);
        }
        if (params.noSelection) {
            args.push('-NoSelection');
        }

        reportStage?.('Редактирование СКД через PowerShell.');
        const result = await this.runScript({ scriptPath, args, token }, reportStage);

        const cancelled = processCancellationFailure(result);
        if (cancelled) { return cancelled; }
        const truncatedOutput = successfulOutputTruncationFailure(result);
        if (truncatedOutput) { return truncatedOutput; }

        if (result.exitCode !== 0) {
            const errMsg = result.stderr.trim() || result.stdout.trim() || `skd-edit failed with exit code ${result.exitCode}`;
            return { success: false, error: errMsg };
        }

        // Last line: "[OK] Saved {path}"
        const savedPath = parseSavedPath(result.stdout);

        return {
            success: true,
            data: {
                output: savedPath || templatePath,
                rawOutput: result.stdout,
            },
        };
    }

    // ─── skd.validate ─────────────────────────────────────────────────────────

    /**
     * Валидирует структуру СКД.
     * Использует skd-validate.ps1 (-TemplatePath, -Detailed, -MaxErrors, -OutFile).
     */
    async skdValidate(
        params: SkdValidateParams,
        token?: vscode.CancellationToken,
        reportStage?: (message: string) => void,
    ): Promise<AgentResult<SkdValidateResult | SkdOperationInDoubtResult>> {
        const stopped = cancellationFailure(token);
        if (stopped) { return stopped; }
        if (!params.templatePath) {
            return { success: false, error: 'параметр templatePath обязателен' };
        }

        const resolvedTemplate = await this.resolveTemplatePath(params.templatePath, false, true);
        if (resolvedTemplate.failure) { return resolvedTemplate.failure; }
        const templatePath = resolvedTemplate.path!;
        let outFile = params.outFile;
        if (outFile) {
            const resolvedReport = await this.resolveReportPath(outFile, templatePath);
            if (resolvedReport.failure) { return resolvedReport.failure; }
            outFile = resolvedReport.path!;
        }

        const scriptPath = path.join(this.deps.extensionPath, 'resources', 'skd', 'skd-validate.ps1');
        const args: string[] = ['-TemplatePath', templatePath];

        if (params.detailed) {
            args.push('-Detailed');
        }
        if (params.maxErrors !== undefined) {
            args.push('-MaxErrors', String(params.maxErrors));
        }
        if (outFile) {
            args.push('-OutFile', outFile);
        }

        reportStage?.('Проверка СКД через PowerShell.');
        const result = await this.runScript({ scriptPath, args, token }, reportStage);

        const cancelled = processCancellationFailure(result);
        if (cancelled) { return cancelled; }
        const truncatedOutput = successfulOutputTruncationFailure(result);
        if (truncatedOutput) { return truncatedOutput; }

        const rawOutput = result.stdout;
        const hasValidationReport = /===\s*(?:Validation|Result:)/i.test(rawOutput);

        if (result.exitCode !== 0 && !hasValidationReport) {
            // exitCode 1 without validation report means file not found or PowerShell script error
            const errMsg = result.stderr.trim() || result.stdout.trim() || `skd-validate failed with exit code ${result.exitCode}`;
            return { success: false, error: errMsg };
        }

        const errorCount = countMatches(rawOutput, /^\[ERROR\]/m);
        const warningCount = countMatches(rawOutput, /^\[WARN\]/m);
        const valid = errorCount === 0 && warningCount === 0;

        const xsdNotCheckedMatch = rawOutput.match(/XSD not checked:\s*([^;\r\n]+?)(?:\)\s*===|$)/i)
            ?? rawOutput.match(/XSD:[^—\n\r]*—\s*not checked(?::\s*([^\n\r]+))?/i);
        const xsdFallbackMatch = rawOutput.match(/\((no schemas for\s+[^)]+)\)/i);

        let xsdChecked = false;
        let xsdReason: string | undefined;
        let coverage: 'full' | 'partial' = 'partial';

        if (xsdNotCheckedMatch) {
            xsdChecked = false;
            xsdReason = (xsdNotCheckedMatch[1] ?? xsdNotCheckedMatch[0]).trim();
            coverage = 'partial';
        } else if (xsdFallbackMatch) {
            xsdChecked = true;
            xsdReason = xsdFallbackMatch[1].trim();
            coverage = 'partial';
        } else {
            const hasXsdMention = /\bXSD\s+\d+(\.\d+)*\b/i.test(rawOutput);
            if (hasXsdMention) {
                xsdChecked = true;
                coverage = 'full';
            } else {
                xsdChecked = false;
                coverage = 'partial';
                xsdReason = 'no schemas';
            }
        }

        return {
            success: true,
            data: {
                valid,
                coverage,
                xsdChecked,
                ...(xsdReason !== undefined ? { xsdReason } : {}),
                errorCount,
                warningCount,
                rawOutput,
            },
        };
    }
}

function cancellationFailure(token: vscode.CancellationToken | undefined): AgentResult<never> | undefined {
    return token?.isCancellationRequested
        ? { success: false, code: 'REQUEST_CANCELLED', error: 'Операция отменена до запуска PowerShell.' }
        : undefined;
}

function processCancellationFailure(
    result: Awaited<ReturnType<typeof runPowerShellScript>>,
): AgentResult<SkdOperationInDoubtResult> | AgentResult<never> | undefined {
    if (result.cancelled && !result.effectPossible) {
        return { success: false, code: 'REQUEST_CANCELLED', error: 'Операция отменена до запуска PowerShell.' };
    }
    const terminationUnconfirmed = result.termination?.terminated === false;
    if (
        (result.cancelled || result.cancellationRequested || result.timedOut)
        && result.effectPossible
    ) {
        const survivingPids = result.termination?.survivingPids ?? [];
        const terminationDetails = terminationUnconfirmed
            ? ` Завершение дерева процессов PowerShell не подтверждено${survivingPids.length > 0
                ? `; активные PID: ${survivingPids.join(', ')}`
                : ''}.`
            : '';
        const operationDetails = result.timedOut
            ? 'PowerShell превысил таймаут; исход файловой операции не подтверждён.'
            : 'Операция отменена после запуска PowerShell; исход файловой операции не подтверждён.';
        return {
            success: false,
            code: 'SKD_OPERATION_IN_DOUBT',
            data: { status: 'inDoubt', effectPossible: true },
            error: `${operationDetails}${terminationDetails}`,
        };
    }
    return undefined;
}

function successfulOutputTruncationFailure(
    result: Awaited<ReturnType<typeof runPowerShellScript>>,
): AgentResult<never> | undefined {
    if (result.exitCode !== 0 || (!result.stdoutTruncated && !result.stderrTruncated)) {
        return undefined;
    }

    const truncatedStreams: string[] = [];
    if (result.stdoutTruncated) { truncatedStreams.push('stdout'); }
    if (result.stderrTruncated) { truncatedStreams.push('stderr'); }
    return {
        success: false,
        code: 'SKD_OUTPUT_TRUNCATED',
        error: `Вывод PowerShell усечён (${truncatedStreams.join(', ')}); результат СКД не разбирался.`,
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Парсит путь из первой строки stdout skd-compile: "OK  {path}". */
function parseCompileOutputPath(line: string): string {
    const m = line.match(/^OK\s+(.+)$/);
    return m ? m[1].trim() : '';
}

/** Парсит статистику из строк 2–3 stdout skd-compile. */
function parseCompileStats(statsLine: string, sizeLine: string): SkdCompileResult['stats'] {
    const ds = extractNum(statsLine, /DataSets:\s*(\d+)/);
    const fields = extractNum(statsLine, /Fields:\s*(\d+)/);
    const calculated = extractNum(statsLine, /Calculated:\s*(\d+)/);
    const totals = extractNum(statsLine, /Totals:\s*(\d+)/);
    const params = extractNum(statsLine, /Params:\s*(\d+)/);
    const variants = extractNum(statsLine, /Variants:\s*(\d+)/);
    const sizeBytes = extractNum(sizeLine, /Size:\s*(\d+)/);

    if (ds === undefined) {
        return undefined;
    }
    return {
        dataSets: ds ?? 0,
        fields: fields ?? 0,
        calculated: calculated ?? 0,
        totals: totals ?? 0,
        parameters: params ?? 0,
        variants: variants ?? 0,
        sizeBytes: sizeBytes ?? 0,
    };
}

function extractNum(text: string, re: RegExp): number | undefined {
    const m = text.match(re);
    return m ? Number.parseInt(m[1], 10) : undefined;
}

/** Парсит сохранённый путь из строки "[OK] Saved {path}". */
function parseSavedPath(stdout: string): string {
    const m = stdout.match(/\[OK\] Saved (.+)/);
    return m ? m[1].trim() : '';
}

/** Считает количество совпадений regex в тексте. */
function countMatches(text: string, re: RegExp): number {
    return (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) ?? []).length;
}
