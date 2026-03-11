/**
 * Russian labels for metadata properties
 */
export const PropertyLabels: Record<string, string> = {
  // CommonModule properties
  'Global': 'Глобальный',
  'ClientManagedApplication': 'Клиент (управляемое приложение)',
  'Server': 'Сервер',
  'ExternalConnection': 'Внешнее соединение',
  'ClientOrdinaryApplication': 'Клиент (обычное приложение)',
  'ServerCall': 'Вызов сервера',
  'Privileged': 'Привилегированный',
  'ReturnValuesReuse': 'Повторное использование возвращаемых значений',
  
  // Common properties
  'Name': 'Имя',
  'Synonym': 'Синоним',
  'Comment': 'Комментарий',
  'type': 'Тип',
};

/**
 * Get Russian label for property name, fallback to original name
 */
export function getPropertyLabel(propertyName: string): string {
  return PropertyLabels[propertyName] || propertyName;
}
