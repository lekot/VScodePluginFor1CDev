import { z } from 'zod';
import type { McpToolDefinition } from './types';
import { READ_OPEN, WRITE_OPEN } from './types';
import {
  debuggeeType,
  debugServerPort,
  debugThreadInput,
  nonEmptyString,
  sessionInput,
  stringArray,
} from './schemas';

const debugStartInput = z.strictObject({
  rootProject: nonEmptyString,
  infobase: nonEmptyString,
  platformPath: nonEmptyString,
  extensions: stringArray.optional(),
  debugServerHost: z.string().optional(),
  debugServerPort: debugServerPort.optional(),
  debuggeeType: debuggeeType.optional(),
  databasePath: z.string().optional(),
}).refine((value) => value.debuggeeType !== 'webServer'
  || Boolean(value.databasePath || /File\s*=\s*([^;]+)/i.test(value.infobase)), {
  message: 'webServer requires databasePath or a File= infobase connection string',
});

const setBreakpointInput = z.strictObject({
  file: nonEmptyString,
  line: z.number().int().positive(),
  condition: z.string().optional(),
  hitCondition: z.string().optional(),
  logMessage: z.string().optional(),
});

const clearBreakpointsInput = z.strictObject({ file: z.string().optional() });

const exceptionFilterInput = z.strictObject({
  sessionId: nonEmptyString,
  enabled: z.boolean(),
  substring: z.string().optional(),
});

const waitForStopInput = z.strictObject({
  sessionId: nonEmptyString,
  timeoutMs: z.number().optional(),
});

const debugFrameInput = z.strictObject({
  sessionId: nonEmptyString,
  frameId: z.number(),
});

const debugVariablesInput = z.strictObject({
  sessionId: nonEmptyString,
  varRef: z.number(),
});

const debugEvaluateInput = z.strictObject({
  sessionId: nonEmptyString,
  expression: nonEmptyString,
  frameId: z.number().optional(),
});

const startFromBindingInput = z.strictObject({
  configPath: nonEmptyString.optional(),
  debuggeeType: debuggeeType.optional(),
});

export const DEBUG_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'cdt_debug_start',
    description: 'Start a 1C debug session. Launches external platform/debuggee processes.',
    command: '1c-metadata-tree.agent.debug.start',
    inputSchema: debugStartInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_debug_stop',
    description: 'Stop a running 1C debug session.',
    command: '1c-metadata-tree.agent.debug.stop',
    inputSchema: sessionInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_debug_set_breakpoint',
    description: 'Add a global VS Code source breakpoint for 1C debugging.',
    command: '1c-metadata-tree.agent.debug.setBreakpoint',
    inputSchema: setBreakpointInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_debug_clear_breakpoints',
    description: 'Remove breakpoints for one file, or all global breakpoints when file is omitted.',
    command: '1c-metadata-tree.agent.debug.clearBreakpoints',
    inputSchema: clearBreakpointsInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_debug_set_exception_filter',
    description: 'Change exception-breakpoint settings in a running debug session.',
    command: '1c-metadata-tree.agent.debug.setExceptionFilter',
    inputSchema: exceptionFilterInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_debug_wait_for_stop',
    description: 'Wait for a running debug session to stop and return its top frame.',
    command: '1c-metadata-tree.agent.debug.waitForStop',
    inputSchema: waitForStopInput,
    annotations: READ_OPEN,
  },
  {
    name: 'cdt_debug_get_stack_trace',
    description: 'Read the call stack of a stopped debug thread.',
    command: '1c-metadata-tree.agent.debug.getStackTrace',
    inputSchema: debugThreadInput,
    annotations: READ_OPEN,
  },
  {
    name: 'cdt_debug_get_scopes',
    description: 'Read variable scopes for a stopped debug frame.',
    command: '1c-metadata-tree.agent.debug.getScopes',
    inputSchema: debugFrameInput,
    annotations: READ_OPEN,
  },
  {
    name: 'cdt_debug_get_variables',
    description: 'Read variables from a debug scope or expandable value.',
    command: '1c-metadata-tree.agent.debug.getVariables',
    inputSchema: debugVariablesInput,
    annotations: READ_OPEN,
  },
  {
    name: 'cdt_debug_evaluate',
    description: 'Evaluate an arbitrary BSL expression in a debug session; the expression may have side effects.',
    command: '1c-metadata-tree.agent.debug.evaluate',
    inputSchema: debugEvaluateInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_debug_continue',
    description: 'Continue execution of a stopped debug thread.',
    command: '1c-metadata-tree.agent.debug.continue',
    inputSchema: debugThreadInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_debug_step_over',
    description: 'Step over the current statement in a stopped debug thread.',
    command: '1c-metadata-tree.agent.debug.stepOver',
    inputSchema: debugThreadInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_debug_step_in',
    description: 'Step into the current call in a stopped debug thread.',
    command: '1c-metadata-tree.agent.debug.stepIn',
    inputSchema: debugThreadInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_debug_step_out',
    description: 'Step out of the current call in a stopped debug thread.',
    command: '1c-metadata-tree.agent.debug.stepOut',
    inputSchema: debugThreadInput,
    annotations: WRITE_OPEN,
  },
  {
    name: 'cdt_debug_start_from_binding',
    description: 'Resolve an infobase binding and start a 1C debug session.',
    command: '1c-metadata-tree.agent.debug.startFromBinding',
    inputSchema: startFromBindingInput,
    annotations: WRITE_OPEN,
  },
] as const;
