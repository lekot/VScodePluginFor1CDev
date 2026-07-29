import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { MCP_TOOL_CATALOG } from '../../src/agent/mcpAdapter/toolCatalog';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

type AnnotationKind = 'readClosed' | 'writeClosed' | 'readOpen' | 'writeOpen' | 'verifyOpen';

interface ExpectedTool {
  readonly name: string;
  readonly command: string;
  readonly annotations: AnnotationKind;
}

const PREFIX = '1c-metadata-tree.agent.';
const tool = (name: string, command: string, annotations: AnnotationKind): ExpectedTool => ({
  name,
  command: `${PREFIX}${command}`,
  annotations,
});

const EXPECTED_TOOLS: readonly ExpectedTool[] = [
  tool('cdt_list_configurations', 'listConfigurations', 'readClosed'),
  tool('cdt_create_object', 'createObject', 'writeClosed'),
  tool('cdt_get_yaml', 'getYaml', 'readClosed'),
  tool('cdt_list_objects', 'listObjects', 'readClosed'),
  tool('cdt_get_properties', 'getProperties', 'readClosed'),
  tool('cdt_add_attribute', 'addAttribute', 'writeClosed'),
  tool('cdt_add_tabular_section', 'addTabularSection', 'writeClosed'),
  tool('cdt_add_tabular_section_column', 'addTabularSectionColumn', 'writeClosed'),
  tool('cdt_delete_attribute', 'deleteAttribute', 'writeClosed'),
  tool('cdt_delete_tabular_section', 'deleteTabularSection', 'writeClosed'),
  tool('cdt_delete_object', 'deleteObject', 'writeClosed'),
  tool('cdt_rename_object', 'renameObject', 'writeClosed'),
  tool('cdt_set_properties', 'setProperties', 'writeClosed'),

  tool('cdt_debug_start', 'debug.start', 'writeOpen'),
  tool('cdt_debug_stop', 'debug.stop', 'writeOpen'),
  tool('cdt_debug_set_breakpoint', 'debug.setBreakpoint', 'writeOpen'),
  tool('cdt_debug_clear_breakpoints', 'debug.clearBreakpoints', 'writeOpen'),
  tool('cdt_debug_set_exception_filter', 'debug.setExceptionFilter', 'writeOpen'),
  tool('cdt_debug_wait_for_stop', 'debug.waitForStop', 'readOpen'),
  tool('cdt_debug_get_stack_trace', 'debug.getStackTrace', 'readOpen'),
  tool('cdt_debug_get_scopes', 'debug.getScopes', 'readOpen'),
  tool('cdt_debug_get_variables', 'debug.getVariables', 'readOpen'),
  tool('cdt_debug_evaluate', 'debug.evaluate', 'writeOpen'),
  tool('cdt_debug_continue', 'debug.continue', 'writeOpen'),
  tool('cdt_debug_step_over', 'debug.stepOver', 'writeOpen'),
  tool('cdt_debug_step_in', 'debug.stepIn', 'writeOpen'),
  tool('cdt_debug_step_out', 'debug.stepOut', 'writeOpen'),
  tool('cdt_debug_start_from_binding', 'debug.startFromBinding', 'writeOpen'),

  tool('cdt_resolve_binding', 'resolveBinding', 'readClosed'),
  tool('cdt_list_bindings', 'listBindings', 'readClosed'),
  tool('cdt_deploy', 'deploy', 'writeOpen'),
  tool('cdt_deploy_selected_objects', 'deploySelectedObjects', 'writeOpen'),
  tool('cdt_deploy_changed_files', 'deployChangedFiles', 'writeOpen'),
  tool('cdt_pull_selected_objects', 'pullSelectedObjects', 'writeOpen'),
  tool('cdt_export_status', 'exportStatus', 'readOpen'),

  tool('cdt_get_type', 'getType', 'readClosed'),
  tool('cdt_set_type', 'setType', 'writeClosed'),
  tool('cdt_get_subsystem_command_interface', 'getSubsystemCommandInterface', 'readClosed'),
  tool('cdt_set_subsystem_command_visibility', 'setSubsystemCommandVisibility', 'writeClosed'),
  tool('cdt_set_subsystem_command_order', 'setSubsystemCommandOrder', 'writeClosed'),
  tool('cdt_set_subsystem_subsystems_order', 'setSubsystemSubsystemsOrder', 'writeClosed'),
  tool('cdt_list_predefined_characteristics', 'listPredefinedCharacteristics', 'readClosed'),
  tool('cdt_get_predefined_characteristic_type', 'getPredefinedCharacteristicType', 'readClosed'),
  tool('cdt_set_predefined_characteristic_type', 'setPredefinedCharacteristicType', 'writeClosed'),
  tool('cdt_get_characteristic_value_registers', 'getCharacteristicValueRegisters', 'readClosed'),

  tool('cdt_forms_start', 'forms.start', 'writeOpen'),
  tool('cdt_forms_exec', 'forms.exec', 'writeOpen'),
  tool('cdt_forms_stop', 'forms.stop', 'writeOpen'),
  tool('cdt_forms_shot', 'forms.shot', 'writeOpen'),
  tool('cdt_forms_status', 'forms.status', 'readOpen'),

  tool('cdt_skd_compile', 'skd.compile', 'writeOpen'),
  tool('cdt_skd_info', 'skd.info', 'writeOpen'),
  tool('cdt_skd_edit', 'skd.edit', 'writeOpen'),
  tool('cdt_skd_validate', 'skd.validate', 'writeOpen'),

  tool('cdt_xdto_list_packages', 'xdto.listPackages', 'readClosed'),
  tool('cdt_xdto_get_package', 'xdto.getPackage', 'readClosed'),
  tool('cdt_xdto_export_xsd', 'xdto.exportXsd', 'writeClosed'),
  tool('cdt_xdto_import_xsd', 'xdto.importXsd', 'writeClosed'),
  tool('cdt_xdto_create_from_xsd', 'xdto.createFromXsd', 'writeClosed'),
  tool('cdt_xdto_compare', 'xdto.compare', 'readClosed'),
  tool('cdt_xdto_merge', 'xdto.merge', 'writeClosed'),

  tool('cdt_support_get_status', 'supportGetStatus', 'readClosed'),
  tool('cdt_support_set_object_mode', 'supportSetObjectMode', 'writeOpen'),
  tool('cdt_support_enable_object_rules', 'supportEnableObjectRules', 'writeOpen'),
  tool('cdt_support_sync', 'supportSync', 'writeOpen'),
  tool('cdt_support_verify', 'supportVerify', 'verifyOpen'),
  tool('cdt_support_get_last_run', 'supportGetLastRun', 'readClosed'),

  tool('cdt_dump_external_processor', 'dumpExternalProcessor', 'readOpen'),
  tool('cdt_build_external_processor', 'buildExternalProcessor', 'writeOpen'),
];

const EXPECTED_ANNOTATIONS: Readonly<Record<AnnotationKind, Readonly<Record<string, boolean>>>> = {
  readClosed: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  writeClosed: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  readOpen: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  writeOpen: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  verifyOpen: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

const VALID_INPUTS: Readonly<Record<string, Record<string, unknown>>> = {
  cdt_list_configurations: {},
  cdt_create_object: { configurationId: 'cfg', type: 'Catalog', name: 'Goods', synonym: 'Goods', properties: { nested: { enabled: true }, values: [1, null] } },
  cdt_get_yaml: { configurationId: 'cfg', path: 'Catalog.Goods' },
  cdt_list_objects: { configurationId: 'cfg', type: 'Catalog', query: 'good' },
  cdt_get_properties: { configurationId: 'cfg', path: 'Catalog.Goods' },
  cdt_add_attribute: { configurationId: 'cfg', path: 'Catalog.Goods', name: 'VendorCode' },
  cdt_add_tabular_section: { configurationId: 'cfg', path: 'Catalog.Goods', name: 'Items' },
  cdt_add_tabular_section_column: { configurationId: 'cfg', path: 'Catalog.Goods.TabularSection.Items', name: 'Quantity' },
  cdt_delete_attribute: { configurationId: 'cfg', path: 'Catalog.Goods.Attribute.VendorCode' },
  cdt_delete_tabular_section: { configurationId: 'cfg', path: 'Catalog.Goods.TabularSection.Items' },
  cdt_delete_object: { configurationId: 'cfg', path: 'Catalog.Goods' },
  cdt_rename_object: { configurationId: 'cfg', path: 'Catalog.Goods', newName: 'Products' },
  cdt_set_properties: { configurationId: 'cfg', path: 'Catalog.Goods', properties: { nested: { enabled: true }, values: [1, null] } },
  cdt_debug_start: { rootProject: 'C:/project', infobase: 'File=C:/db', platformPath: 'C:/1cv8', extensions: ['C:/ext'], debugServerHost: '127.0.0.1', debugServerPort: 1550, debuggeeType: 'thinClient', databasePath: 'C:/db' },
  cdt_debug_stop: { sessionId: 'session' },
  cdt_debug_set_breakpoint: { file: 'C:/project/Module.bsl', line: 1, condition: 'true', hitCondition: '1', logMessage: 'hit' },
  cdt_debug_clear_breakpoints: { file: 'C:/project/Module.bsl' },
  cdt_debug_set_exception_filter: { sessionId: 'session', enabled: true, substring: 'error' },
  cdt_debug_wait_for_stop: { sessionId: 'session', timeoutMs: 1000 },
  cdt_debug_get_stack_trace: { sessionId: 'session', threadId: 1 },
  cdt_debug_get_scopes: { sessionId: 'session', frameId: 1 },
  cdt_debug_get_variables: { sessionId: 'session', varRef: 1 },
  cdt_debug_evaluate: { sessionId: 'session', expression: 'Counter', frameId: 1 },
  cdt_debug_continue: { sessionId: 'session', threadId: 1 },
  cdt_debug_step_over: { sessionId: 'session', threadId: 1 },
  cdt_debug_step_in: { sessionId: 'session', threadId: 1 },
  cdt_debug_step_out: { sessionId: 'session', threadId: 1 },
  cdt_debug_start_from_binding: { configPath: 'C:/project/Configuration.xml', debuggeeType: 'webServer' },
  cdt_resolve_binding: { configPath: 'C:/project/Configuration.xml' },
  cdt_list_bindings: {},
  cdt_deploy: { configurationId: 'cfg', configPath: 'C:/project' },
  cdt_deploy_selected_objects: { configurationId: 'cfg', configPath: 'C:/project', files: ['Catalogs/Goods.xml'] },
  cdt_deploy_changed_files: { configurationId: 'cfg', configPath: 'C:/project' },
  cdt_pull_selected_objects: { configurationId: 'cfg', configPath: 'C:/project', objectIds: ['Catalog.Goods'], infobaseName: 'main' },
  cdt_export_status: { configurationId: 'cfg', configPath: 'C:/project' },
  cdt_get_type: { configurationId: 'cfg', path: 'Catalog.Goods.Attribute.VendorCode' },
  cdt_set_type: { configurationId: 'cfg', path: 'Catalog.Goods.Attribute.VendorCode', types: ['xs:string'] },
  cdt_get_subsystem_command_interface: { configurationId: 'cfg', subsystemPath: 'Subsystem.Sales' },
  cdt_set_subsystem_command_visibility: { configurationId: 'cfg', subsystemPath: 'Subsystem.Sales', commandName: 'Catalog.Goods.Command.Open', common: 'visible' },
  cdt_set_subsystem_command_order: { configurationId: 'cfg', subsystemPath: 'Subsystem.Sales', entries: [{ commandName: 'Catalog.Goods.Command.Open', commandGroup: 'NavigationPanelImportant' }] },
  cdt_set_subsystem_subsystems_order: { configurationId: 'cfg', subsystemPath: 'Subsystem.Sales', order: ['Subsystem.Inventory'] },
  cdt_list_predefined_characteristics: { configurationId: 'cfg', path: 'ChartOfCharacteristicTypes.Kinds' },
  cdt_get_predefined_characteristic_type: { configurationId: 'cfg', path: 'ChartOfCharacteristicTypes.Kinds', predefinedName: 'Color' },
  cdt_set_predefined_characteristic_type: { configurationId: 'cfg', path: 'ChartOfCharacteristicTypes.Kinds', predefinedName: 'Color', types: ['xs:string'] },
  cdt_get_characteristic_value_registers: { configurationId: 'cfg', path: 'ChartOfCharacteristicTypes.Kinds' },
  cdt_forms_start: { url: 'http://localhost/app', readyTimeoutMs: 1000 },
  cdt_forms_exec: { script: 'return true;', timeoutMs: 1000 },
  cdt_forms_stop: {},
  cdt_forms_shot: { file: 'C:/temp/form.png' },
  cdt_forms_status: {},
  cdt_skd_compile: { value: '{}', outputPath: 'C:/project/template.xml' },
  cdt_skd_info: { templatePath: 'C:/project/template.xml', mode: 'overview', name: 'main', batch: 1, limit: 10, offset: 0, outFile: 'C:/temp/info.json' },
  cdt_skd_edit: { templatePath: 'C:/project/template.xml', operation: 'add-field', value: '{}', dataSet: 'Main', variant: 'Default', noSelection: false },
  cdt_skd_validate: { templatePath: 'C:/project/template.xml', detailed: true, maxErrors: 10, outFile: 'C:/temp/validation.json' },
  cdt_xdto_list_packages: { configurationId: 'cfg' },
  cdt_xdto_get_package: { configurationId: 'cfg', packageName: 'example', includeSource: true },
  cdt_xdto_export_xsd: { configurationId: 'cfg', metadataPath: 'XDTOPackage.example', outputPath: 'C:/project/example.xsd', includeSource: true },
  cdt_xdto_import_xsd: { configurationId: 'cfg', packageName: 'example', source: '<xs:schema/>' },
  cdt_xdto_create_from_xsd: { configurationId: 'cfg', packageName: 'example', inputPath: 'C:/project/example.xsd' },
  cdt_xdto_compare: { configurationId: 'cfg', packageName: 'example', source: '<xs:schema/>', includeTree: true, joinStrategy: 'full' },
  cdt_xdto_merge: { configurationId: 'cfg', metadataPath: 'XDTOPackage.example', inputPath: 'C:/project/example.xsd', selectedIds: ['type:Product'], joinStrategy: 'left' },
  cdt_support_get_status: {
    configurationId: 'cfg',
    objectIds: ['11111111-1111-1111-1111-111111111111'],
  },
  cdt_support_set_object_mode: {
    configurationId: 'cfg',
    objectId: '11111111-1111-1111-1111-111111111111',
    targetMode: 'editableWithSupport',
    expectedGenerationId: 'a'.repeat(64),
  },
  cdt_support_enable_object_rules: {
    configurationId: 'cfg',
    targetObjectId: '11111111-1111-1111-1111-111111111111',
    targetMode: 'removedFromSupport',
    expectedGenerationId: 'b'.repeat(64),
    expectedMetadataUniverseGenerationId: 'c'.repeat(64),
  },
  cdt_support_sync: {
    configurationId: 'cfg',
    targets: { kind: 'ids', targetIds: ['file:C:/db/main'] },
    verification: 'strict',
  },
  cdt_support_verify: {
    configurationId: 'cfg',
    targets: { kind: 'all' },
  },
  cdt_support_get_last_run: { configurationId: 'cfg' },
  cdt_dump_external_processor: { srcPath: 'C:/test/file.epf' },
  cdt_build_external_processor: { srcDir: 'C:/test/file_src' },
};

interface InvalidRefinementCase {
  readonly label: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

const INVALID_REFINEMENT_CASES: readonly InvalidRefinementCase[] = [
  { label: 'createObject empty type', tool: 'cdt_create_object', input: { type: '', name: 'Goods' } },
  { label: 'createObject empty name', tool: 'cdt_create_object', input: { type: 'Catalog', name: '' } },
  { label: 'createObject invalid type identifier', tool: 'cdt_create_object', input: { type: 'Bad-Type', name: 'Goods' } },
  { label: 'createObject invalid name identifier', tool: 'cdt_create_object', input: { type: 'Catalog', name: '1Goods' } },
  { label: 'addAttribute invalid name identifier', tool: 'cdt_add_attribute', input: { path: 'Catalog.Goods', name: 'Bad-Name' } },
  { label: 'renameObject invalid newName identifier', tool: 'cdt_rename_object', input: { path: 'Catalog.Goods', newName: 'Bad-Name' } },

  { label: 'Agent path has one segment', tool: 'cdt_get_yaml', input: { path: 'Catalog' } },
  { label: 'Agent path has three segments', tool: 'cdt_get_properties', input: { path: 'Catalog.Goods.Attribute' } },
  { label: 'Agent path has five segments', tool: 'cdt_set_properties', input: { path: 'Catalog.Goods.Attribute.Code.Extra', properties: {} } },
  { label: 'Agent path contains invalid identifier', tool: 'cdt_delete_object', input: { path: 'Catalog.Bad-Name' } },
  { label: 'root object path has four segments', tool: 'cdt_rename_object', input: { path: 'Catalog.Goods.Attribute.Code', newName: 'Products' } },
  { label: 'attribute path has two segments', tool: 'cdt_delete_attribute', input: { path: 'Catalog.Goods' } },
  { label: 'attribute path has invalid segment', tool: 'cdt_delete_attribute', input: { path: 'Catalog.Goods.Attribute.Bad-Name' } },
  { label: 'tabular section path has wrong marker', tool: 'cdt_add_tabular_section_column', input: { path: 'Catalog.Goods.Attribute.Items', name: 'Quantity' } },
  { label: 'tabular section path has six segments', tool: 'cdt_delete_tabular_section', input: { path: 'Catalog.Goods.TabularSection.Items.Attribute.Quantity' } },
  { label: 'setProperties cannot rename through Name', tool: 'cdt_set_properties', input: { path: 'Catalog.Goods', properties: { Name: 'Products' } } },
  { label: 'setType rejects unsupported primitive type', tool: 'cdt_set_type', input: { path: 'Catalog.Goods.Attribute.Code', types: ['xs:integer'] } },
  { label: 'setType rejects incomplete cfg reference', tool: 'cdt_set_type', input: { path: 'Catalog.Goods.Attribute.Code', types: ['cfg:CatalogRef'] } },

  { label: 'debugStart empty rootProject', tool: 'cdt_debug_start', input: { rootProject: '', infobase: 'File=C:/db', platformPath: 'C:/1cv8' } },
  { label: 'debugStart empty infobase', tool: 'cdt_debug_start', input: { rootProject: 'C:/project', infobase: '', platformPath: 'C:/1cv8' } },
  { label: 'debugStart empty platformPath', tool: 'cdt_debug_start', input: { rootProject: 'C:/project', infobase: 'File=C:/db', platformPath: '' } },
  { label: 'debugStart port zero', tool: 'cdt_debug_start', input: { rootProject: 'C:/project', infobase: 'File=C:/db', platformPath: 'C:/1cv8', debugServerPort: 0 } },
  { label: 'debugStart port above 65535', tool: 'cdt_debug_start', input: { rootProject: 'C:/project', infobase: 'File=C:/db', platformPath: 'C:/1cv8', debugServerPort: 65536 } },
  { label: 'debugStart fractional port', tool: 'cdt_debug_start', input: { rootProject: 'C:/project', infobase: 'File=C:/db', platformPath: 'C:/1cv8', debugServerPort: 1550.5 } },
  { label: 'debugStart webServer without file database', tool: 'cdt_debug_start', input: { rootProject: 'C:/project', infobase: 'Srvr=host;Ref=db', platformPath: 'C:/1cv8', debuggeeType: 'webServer' } },
  { label: 'debugStart webServer with empty databasePath', tool: 'cdt_debug_start', input: { rootProject: 'C:/project', infobase: 'Srvr=host;Ref=db', platformPath: 'C:/1cv8', debuggeeType: 'webServer', databasePath: '' } },
  { label: 'debugStop empty session', tool: 'cdt_debug_stop', input: { sessionId: '' } },
  { label: 'exception filter empty session', tool: 'cdt_debug_set_exception_filter', input: { sessionId: '', enabled: true } },
  { label: 'waitForStop empty session', tool: 'cdt_debug_wait_for_stop', input: { sessionId: '' } },
  { label: 'stack trace empty session', tool: 'cdt_debug_get_stack_trace', input: { sessionId: '', threadId: 1 } },
  { label: 'scopes empty session', tool: 'cdt_debug_get_scopes', input: { sessionId: '', frameId: 1 } },
  { label: 'variables empty session', tool: 'cdt_debug_get_variables', input: { sessionId: '', varRef: 1 } },
  { label: 'evaluate empty session', tool: 'cdt_debug_evaluate', input: { sessionId: '', expression: 'Counter' } },
  { label: 'continue empty session', tool: 'cdt_debug_continue', input: { sessionId: '', threadId: 1 } },
  { label: 'stepOver empty session', tool: 'cdt_debug_step_over', input: { sessionId: '', threadId: 1 } },
  { label: 'stepIn empty session', tool: 'cdt_debug_step_in', input: { sessionId: '', threadId: 1 } },
  { label: 'stepOut empty session', tool: 'cdt_debug_step_out', input: { sessionId: '', threadId: 1 } },
  { label: 'breakpoint empty file', tool: 'cdt_debug_set_breakpoint', input: { file: '', line: 1 } },
  { label: 'breakpoint line zero', tool: 'cdt_debug_set_breakpoint', input: { file: 'Module.bsl', line: 0 } },
  { label: 'breakpoint fractional line', tool: 'cdt_debug_set_breakpoint', input: { file: 'Module.bsl', line: 1.5 } },
  { label: 'evaluate empty expression', tool: 'cdt_debug_evaluate', input: { sessionId: 'session', expression: '' } },
  { label: 'startFromBinding supplied empty path', tool: 'cdt_debug_start_from_binding', input: { configPath: '' } },

  { label: 'resolveBinding supplied empty path', tool: 'cdt_resolve_binding', input: { configPath: '' } },
  { label: 'deploySelectedObjects empty files', tool: 'cdt_deploy_selected_objects', input: { files: [] } },
  { label: 'pullSelectedObjects empty objectIds', tool: 'cdt_pull_selected_objects', input: { objectIds: [] } },
  { label: 'formsStart missing url and dbPath', tool: 'cdt_forms_start', input: {} },
  { label: 'formsExec empty script', tool: 'cdt_forms_exec', input: { script: '' } },
  {
    label: 'supportSync ids require at least one target',
    tool: 'cdt_support_sync',
    input: { configurationId: 'cfg', targets: { kind: 'ids', targetIds: [] } },
  },
  {
    label: 'supportVerify ids must be unique',
    tool: 'cdt_support_verify',
    input: {
      configurationId: 'cfg',
      targets: { kind: 'ids', targetIds: ['file:C:/db', 'file:C:/db'] },
    },
  },

  { label: 'SKD compile empty outputPath', tool: 'cdt_skd_compile', input: { value: '{}', outputPath: '' } },
  { label: 'SKD compile missing source', tool: 'cdt_skd_compile', input: { outputPath: 'out.xml' } },
  { label: 'SKD compile has both sources', tool: 'cdt_skd_compile', input: { definitionFile: 'in.json', value: '{}', outputPath: 'out.xml' } },
  { label: 'SKD info empty templatePath', tool: 'cdt_skd_info', input: { templatePath: '' } },
  { label: 'SKD edit empty templatePath', tool: 'cdt_skd_edit', input: { templatePath: '', operation: 'add-field', value: '{}' } },
  { label: 'SKD validate empty templatePath', tool: 'cdt_skd_validate', input: { templatePath: '' } },

  { label: 'XDTO selector empty packageName', tool: 'cdt_xdto_get_package', input: { packageName: '' } },
  { label: 'XDTO selector whitespace packageName', tool: 'cdt_xdto_get_package', input: { packageName: '   ' } },
  { label: 'XDTO selector invalid packageName', tool: 'cdt_xdto_get_package', input: { packageName: 'Bad-Name' } },
  { label: 'XDTO selector whitespace metadataPath', tool: 'cdt_xdto_get_package', input: { metadataPath: '   ' } },
  { label: 'XDTO create whitespace packageName', tool: 'cdt_xdto_create_from_xsd', input: { packageName: '   ', source: '<x/>' } },
  { label: 'XDTO create invalid packageName', tool: 'cdt_xdto_create_from_xsd', input: { packageName: 'Bad-Name', source: '<x/>' } },
  { label: 'XDTO export empty outputPath', tool: 'cdt_xdto_export_xsd', input: { packageName: 'p', outputPath: '' } },
  { label: 'XDTO export whitespace outputPath', tool: 'cdt_xdto_export_xsd', input: { packageName: 'p', outputPath: '   ' } },
  { label: 'XDTO export non-XSD outputPath', tool: 'cdt_xdto_export_xsd', input: { packageName: 'p', outputPath: 'schema.xml' } },
  { label: 'XDTO import missing source', tool: 'cdt_xdto_import_xsd', input: { packageName: 'p' } },
  { label: 'XDTO import empty inputPath only', tool: 'cdt_xdto_import_xsd', input: { packageName: 'p', inputPath: '' } },
  { label: 'XDTO import both sources', tool: 'cdt_xdto_import_xsd', input: { packageName: 'p', inputPath: 'p.xsd', source: '<x/>' } },
  { label: 'XDTO create missing source', tool: 'cdt_xdto_create_from_xsd', input: { packageName: 'p' } },
  { label: 'XDTO create empty inputPath only', tool: 'cdt_xdto_create_from_xsd', input: { packageName: 'p', inputPath: '' } },
  { label: 'XDTO create both sources', tool: 'cdt_xdto_create_from_xsd', input: { packageName: 'p', inputPath: 'p.xsd', source: '<x/>' } },
  { label: 'XDTO compare missing external source', tool: 'cdt_xdto_compare', input: { packageName: 'p' } },
  { label: 'XDTO compare empty inputPath only', tool: 'cdt_xdto_compare', input: { packageName: 'p', inputPath: '' } },
  { label: 'XDTO merge missing external source', tool: 'cdt_xdto_merge', input: { packageName: 'p', selectedIds: [] } },
  { label: 'XDTO merge empty inputPath only', tool: 'cdt_xdto_merge', input: { packageName: 'p', inputPath: '', selectedIds: [] } },
];

function schema(name: string): { safeParse(value: unknown): { success: boolean } } {
  const found = MCP_TOOL_CATALOG.find((candidate) => candidate.name === name);
  assert.ok(found, `MCP tool is missing: ${name}`);
  return found.inputSchema;
}

function accepts(name: string, input: unknown): boolean {
  return schema(name).safeParse(input).success;
}

suite('MCP Agent catalog coverage', () => {
  setup(resetVscodeTestState);
  teardown(resetVscodeTestState);

  test('catalog has the exact 69 name-command-annotation contracts', () => {
    assert.strictEqual(EXPECTED_TOOLS.length, 69, 'test oracle must enumerate all 69 tools');
    assert.strictEqual(new Set(EXPECTED_TOOLS.map(({ name }) => name)).size, 69);
    assert.strictEqual(new Set(EXPECTED_TOOLS.map(({ command }) => command)).size, 69);

    assert.deepStrictEqual(
      MCP_TOOL_CATALOG.map(({ name, command, annotations }) => ({ name, command, annotations })),
      EXPECTED_TOOLS.map(({ name, command, annotations }) => ({
        name,
        command,
        annotations: EXPECTED_ANNOTATIONS[annotations],
      })),
    );
  });

  test('every tool has a description, schema and all four boolean annotations', () => {
    for (const candidate of MCP_TOOL_CATALOG) {
      assert.ok(candidate.description.trim().length > 0, `${candidate.name}: description`);
      assert.strictEqual(typeof candidate.inputSchema.safeParse, 'function', `${candidate.name}: schema`);
      assert.deepStrictEqual(
        Object.keys(candidate.annotations).sort(),
        ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'],
        `${candidate.name}: annotation keys`,
      );
      for (const value of Object.values(candidate.annotations)) {
        assert.strictEqual(typeof value, 'boolean', `${candidate.name}: annotation value`);
      }
    }
  });

  test('support verify advertises external, non-destructive, non-idempotent process effects', () => {
    const verify = MCP_TOOL_CATALOG.find(({ name }) => name === 'cdt_support_verify');
    assert.deepStrictEqual(verify?.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  test('runtime Agent registration is exactly the catalog command set and excludes UI commands', () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerAgentCommands(context as never, () => null, async () => null, new DebugSessionRegistry());
    const registered = vscodeTestState.registeredCommandIds;
    const expectedCommands = EXPECTED_TOOLS.map(({ command }) => command);

    assert.strictEqual(registered.length, 69);
    assert.strictEqual(new Set(registered).size, 69);
    assert.deepStrictEqual([...registered].sort(), [...expectedCommands].sort());
    for (const uiCommand of [
      '1c-metadata-tree.borrowToExtension',
      '1c-metadata-tree.navigateToMainObject',
      '1c-metadata-tree.showRelatedObjects',
      '1c-metadata-tree.showInterceptors',
    ]) {
      assert.ok(!registered.includes(uiCommand), uiCommand);
      assert.ok(!MCP_TOOL_CATALOG.some(({ command }) => command === uiCommand), uiCommand);
    }
  });

  test('all 69 valid fixtures pass and every root schema rejects an extra property', () => {
    assert.deepStrictEqual(Object.keys(VALID_INPUTS).sort(), EXPECTED_TOOLS.map(({ name }) => name).sort());
    for (const { name } of EXPECTED_TOOLS) {
      const input = VALID_INPUTS[name];
      assert.strictEqual(accepts(name, input), true, `${name}: valid fixture`);
      assert.strictEqual(accepts(name, { ...input, unexpectedRootProperty: true }), false, `${name}: strict root`);
    }
  });

  test('every explicit runtime refinement rejects its invalid fixture', () => {
    for (const invalid of INVALID_REFINEMENT_CASES) {
      assert.strictEqual(
        accepts(invalid.tool, invalid.input),
        false,
        `${invalid.label} (${invalid.tool})`,
      );
    }
  });

  test('cross-field and trimming refinements preserve their valid boundary cases', () => {
    assert.strictEqual(accepts('cdt_debug_start', {
      rootProject: 'C:/project',
      infobase: 'Srvr=host;Ref=db',
      platformPath: 'C:/1cv8',
      debuggeeType: 'webServer',
      databasePath: 'C:/db',
    }), true);
    assert.strictEqual(accepts('cdt_debug_start', {
      rootProject: 'C:/project',
      infobase: 'File = C:/db;Usr=admin',
      platformPath: 'C:/1cv8',
      debuggeeType: 'webServer',
    }), true);
    assert.strictEqual(accepts('cdt_xdto_create_from_xsd', {
      packageName: '  example  ',
      source: '<x/>',
    }), true);
    assert.strictEqual(accepts('cdt_xdto_get_package', {
      packageName: '  example  ',
    }), true);
    assert.strictEqual(accepts('cdt_xdto_export_xsd', {
      packageName: 'example',
      outputPath: '  schema.XSD  ',
    }), true);
    for (const name of ['cdt_xdto_import_xsd', 'cdt_xdto_create_from_xsd', 'cdt_xdto_compare']) {
      assert.strictEqual(accepts(name, { packageName: 'example', source: '' }), true, name);
    }
    assert.strictEqual(accepts('cdt_xdto_merge', {
      packageName: 'example', source: '', selectedIds: [],
    }), true);
  });

  test('forms start accepts either or both targets, but not neither', () => {
    assert.strictEqual(accepts('cdt_forms_start', { url: 'http://localhost/app' }), true);
    assert.strictEqual(accepts('cdt_forms_start', { dbPath: 'C:/db' }), true);
    assert.strictEqual(accepts('cdt_forms_start', { url: 'http://localhost/app', dbPath: 'C:/db' }), true);
    assert.strictEqual(accepts('cdt_forms_start', {}), false);
  });

  test('SKD compile requires exactly one source and constrains enums', () => {
    assert.strictEqual(accepts('cdt_skd_compile', { value: '{}', outputPath: 'out.xml' }), true);
    assert.strictEqual(accepts('cdt_skd_compile', { definitionFile: 'in.json', outputPath: 'out.xml' }), true);
    assert.strictEqual(accepts('cdt_skd_compile', { definitionFile: 'in.json', value: '{}', outputPath: 'out.xml' }), false);
    assert.strictEqual(accepts('cdt_skd_compile', { outputPath: 'out.xml' }), false);
    assert.strictEqual(accepts('cdt_skd_info', { templatePath: 'in.xml', mode: 'invalid' }), false);
    assert.strictEqual(accepts('cdt_skd_edit', { templatePath: 'in.xml', operation: 'invalid', value: '{}' }), false);
  });

  test('XDTO selectors and source refinements preserve their distinct semantics', () => {
    assert.strictEqual(accepts('cdt_xdto_get_package', { packageName: 'p' }), true);
    assert.strictEqual(accepts('cdt_xdto_get_package', { metadataPath: 'XDTOPackage.p' }), true);
    assert.strictEqual(accepts('cdt_xdto_get_package', { packageName: 'p', metadataPath: 'XDTOPackage.p' }), true);
    assert.strictEqual(accepts('cdt_xdto_get_package', {}), false);

    assert.strictEqual(accepts('cdt_xdto_import_xsd', { packageName: 'p', source: '<x/>' }), true);
    assert.strictEqual(accepts('cdt_xdto_import_xsd', { packageName: 'p', inputPath: 'p.xsd' }), true);
    assert.strictEqual(accepts('cdt_xdto_import_xsd', { packageName: 'p', source: '<x/>', inputPath: 'p.xsd' }), false);
    assert.strictEqual(accepts('cdt_xdto_import_xsd', { packageName: 'p' }), false);

    assert.strictEqual(accepts('cdt_xdto_create_from_xsd', { packageName: 'p', source: '<x/>' }), true);
    assert.strictEqual(accepts('cdt_xdto_create_from_xsd', { packageName: 'p', inputPath: 'p.xsd' }), true);
    assert.strictEqual(accepts('cdt_xdto_create_from_xsd', { packageName: 'p', source: '<x/>', inputPath: 'p.xsd' }), false);
    assert.strictEqual(accepts('cdt_xdto_create_from_xsd', { packageName: 'p' }), false);

    assert.strictEqual(accepts('cdt_xdto_compare', { packageName: 'p', source: '<x/>', inputPath: 'p.xsd' }), true);
    assert.strictEqual(accepts('cdt_xdto_compare', { packageName: 'p' }), false);
    assert.strictEqual(accepts('cdt_xdto_compare', { packageName: 'p', source: '<x/>', joinStrategy: 'invalid' }), false);

    assert.strictEqual(accepts('cdt_xdto_merge', { packageName: 'p', source: '<x/>', inputPath: 'p.xsd', selectedIds: [] }), true);
    assert.strictEqual(accepts('cdt_xdto_merge', { packageName: 'p', selectedIds: [] }), false);
    assert.strictEqual(accepts('cdt_xdto_merge', { source: '<x/>', selectedIds: [] }), false);
  });

  test('all closed enum domains reject unknown values', () => {
    assert.strictEqual(accepts('cdt_debug_start', {
      rootProject: 'C:/project', infobase: 'File=C:/db', platformPath: 'C:/1cv8', debuggeeType: 'invalid',
    }), false);
    assert.strictEqual(accepts('cdt_debug_start_from_binding', { debuggeeType: 'invalid' }), false);
    assert.strictEqual(accepts('cdt_set_subsystem_command_visibility', {
      subsystemPath: 'Subsystem.Sales', commandName: 'Catalog.Goods.Command.Open', common: 'invalid',
    }), false);
    assert.strictEqual(accepts('cdt_set_subsystem_command_visibility', {
      subsystemPath: 'Subsystem.Sales', commandName: 'Catalog.Goods.Command.Open', common: null,
    }), true);
  });

  test('arbitrary metadata properties stay open while nested command entries stay strict', () => {
    assert.strictEqual(accepts('cdt_set_properties', {
      path: 'Catalog.Goods',
      properties: { anyName: { nested: [1, true, null] } },
    }), true);
    assert.strictEqual(accepts('cdt_set_subsystem_command_order', {
      subsystemPath: 'Subsystem.Sales',
      entries: [{ commandName: 'Catalog.Goods.Command.Open', commandGroup: 'NavigationPanelImportant', extra: true }],
    }), false);
  });
});
