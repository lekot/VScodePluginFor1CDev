// Identifier of a module in 1C Enterprise
export interface RdbgModuleId {
  objectId: string;        // UUID of the metadata object
  propertyId: string;      // UUID of the module type (ObjectModule, ManagerModule, etc.)
  extensionName?: string;  // extension name (if the module belongs to an extension)
}

export interface RdbgTargetInfo {
  id: string;
  seanceId: string;
  userName: string;
  targetType: number;
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
