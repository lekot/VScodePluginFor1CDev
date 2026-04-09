// Identifier of a module in 1C Enterprise
export interface RdbgModuleId {
  objectId: string;        // UUID of the metadata object
  propertyId: string;      // UUID of the module type (ObjectModule, ManagerModule, etc.)
  extensionName?: string;  // extension name (if the module belongs to an extension)
  version?: string;        // module version hash (present in callStack events)
}

export interface RdbgTargetInfo {
  id: string;
  seanceId: string;
  userName: string;
  targetType: string | number;  // "Client", "Server", etc. or numeric
  infobaseAlias: string;
}

export interface RdbgCallStackItem {
  moduleId: RdbgModuleId;
  lineNo: number;
  presentation: string;
}

export interface RdbgBreakpointRequest {
  moduleId: RdbgModuleId;
  lineNo: number;
  /** Whether the breakpoint is enabled. Defaults to true if omitted. */
  isActive?: boolean;
  /** Conditional breakpoint: BSL expression evaluated on every hit; pause only if truthy. */
  condition?: string;
  /** Hit-count breakpoint: integer counter. Pairs with hitCountVariant. */
  hitCount?: number;
  /**
   * Hit-count comparison mode:
   *  - 'eq'         pause when hit counter equals hitCount
   *  - 'ge'         pause when hit counter is greater or equal
   *  - 'multipleOf' pause every hitCount-th hit
   */
  hitCountVariant?: 'eq' | 'ge' | 'multipleOf';
  /**
   * Logpoint message rendered by the platform on hit. When set, the platform
   * prints the rendered text to the output stream and continues execution
   * without pausing.
   */
  logMessage?: string;
}

export interface RdbgBreakpoint {
  moduleId: RdbgModuleId;
  lineNo: number;
  enabled: boolean;
}

export interface RdbgVariable {
  name: string;
  typeName: string;
  value: string;
  isExpandable: boolean;
  variableReference: number;
}

export interface RdbgEvalResult {
  value: string;
  typeName: string;
  isExpandable: boolean;
  error?: string;
}

export interface RdbgRuntimeError {
  description: string;
  moduleId: RdbgModuleId;
  lineNo: number;
}

/**
 * One filter entry for exception breakpoints.
 * Maps to RteFilterItem in Messages.cs (namespace debugRTEFilter).
 *  include: true  → stop only when error text contains `text`
 *  include: false → stop when error text does NOT contain `text`
 * Corresponds to DAP ExceptionFilterOptions.condition.
 */
export interface RdbgExceptionFilterItem {
  include: boolean;  // include (true) or exclude (false) mode
  text: string;      // substring to match against the runtime error description
}

/**
 * State for the "stop on runtime error" setting.
 * Maps to RteFilterStorage in Messages.cs (namespace debugRTEFilter).
 *  stopOnErrors    — master switch; sent as cmd=setBreakOnRTE.
 *  analyzeErrorStr — enable substring filtering (required when filters are present).
 *  filters         — list of include/exclude substring filters (maps to strTemplate[]).
 * Corresponds to DAP SetExceptionBreakpointsArguments.
 */
export interface RdbgExceptionBreakpointState {
  stopOnErrors: boolean;
  analyzeErrorStr?: boolean;    // enable only when filters are present
  filters?: RdbgExceptionFilterItem[];
}
