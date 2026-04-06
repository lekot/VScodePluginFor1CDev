// src/rules/index.ts
import { MetadataRulesRegistry } from './MetadataRulesRegistry';
import { MetadataConverter } from './MetadataConverter';
import { createDefaultConverterRegistry } from './converters';
import {
    accountingRegisterRules,
    accumulationRegisterRules,
    businessProcessRules,
    calculationRegisterRules,
    catalogRules,
    chartOfAccountsRules,
    chartOfCalculationTypesRules,
    chartOfCharacteristicTypesRules,
    dataProcessorRules,
    documentJournalRules,
    documentNumeratorRules,
    filterCriterionRules,
    reportRules,
    commandGroupRules,
    commonAttributeRules,
    commonCommandRules,
    commonFormRules,
    commonModuleRules,
    commonPictureRules,
    commonTemplateRules,
    definedTypeRules,
    constantRules,
    documentRules,
    enumRules,
    exchangePlanRules,
    eventSubscriptionRules,
    functionalOptionRules,
    functionalOptionsParameterRules,
    httpServiceRules,
    informationRegisterRules,
    integrationServiceRules,
    roleRules,
    scheduledJobRules,
    sessionParameterRules,
    settingsStorageRules,
    subsystemRules,
    externalDataSourceRules,
    interfaceRules,
    languageRules,
    styleRules,
    styleItemRules,
    webServiceRules,
    wsReferenceRules,
    taskRules,
    xdtoPackageRules,
} from './metadata';

const converterRegistry = createDefaultConverterRegistry();

export const rulesRegistry = new MetadataRulesRegistry();
rulesRegistry.register(accountingRegisterRules);
rulesRegistry.register(accumulationRegisterRules);
rulesRegistry.register(businessProcessRules);
rulesRegistry.register(calculationRegisterRules);
rulesRegistry.register(catalogRules);
rulesRegistry.register(chartOfAccountsRules);
rulesRegistry.register(chartOfCalculationTypesRules);
rulesRegistry.register(chartOfCharacteristicTypesRules);
rulesRegistry.register(dataProcessorRules);
rulesRegistry.register(documentJournalRules);
rulesRegistry.register(documentNumeratorRules);
rulesRegistry.register(filterCriterionRules);
rulesRegistry.register(reportRules);
rulesRegistry.register(commandGroupRules);
rulesRegistry.register(commonAttributeRules);
rulesRegistry.register(commonCommandRules);
rulesRegistry.register(commonFormRules);
rulesRegistry.register(commonModuleRules);
rulesRegistry.register(commonPictureRules);
rulesRegistry.register(commonTemplateRules);
rulesRegistry.register(definedTypeRules);
rulesRegistry.register(constantRules);
rulesRegistry.register(documentRules);
rulesRegistry.register(enumRules);
rulesRegistry.register(exchangePlanRules);
rulesRegistry.register(eventSubscriptionRules);
rulesRegistry.register(functionalOptionRules);
rulesRegistry.register(functionalOptionsParameterRules);
rulesRegistry.register(httpServiceRules);
rulesRegistry.register(informationRegisterRules);
rulesRegistry.register(integrationServiceRules);
rulesRegistry.register(roleRules);
rulesRegistry.register(scheduledJobRules);
rulesRegistry.register(sessionParameterRules);
rulesRegistry.register(settingsStorageRules);
rulesRegistry.register(subsystemRules);
rulesRegistry.register(taskRules);
rulesRegistry.register(externalDataSourceRules);
rulesRegistry.register(interfaceRules);
rulesRegistry.register(languageRules);
rulesRegistry.register(styleRules);
rulesRegistry.register(styleItemRules);
rulesRegistry.register(webServiceRules);
rulesRegistry.register(wsReferenceRules);
rulesRegistry.register(xdtoPackageRules);

export const metadataConverter = new MetadataConverter(converterRegistry);
