# Обсуждение: Ссылочные свойства в Properties Editor

## Текущая ситуация

### Что реализовано в текущей спецификации (metadata-properties-editor)

**Поддерживаемые типы свойств:**
- ✅ `string` - текстовые свойства (text input)
- ✅ `boolean` - логические свойства (checkbox)
- ✅ `number` - числовые свойства (number input)
- ✅ `unknown` - неизвестные типы (text input по умолчанию)

**Текущая реализация:**
```typescript
function detectPropertyType(value: unknown): 'string' | 'boolean' | 'number' | 'unknown' {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}
```

### Что НЕ реализовано

**Ссылочные типы данных 1С:**
- ❌ `CatalogRef.<ИмяСправочника>` - ссылка на справочник
- ❌ `DocumentRef.<ИмяДокумента>` - ссылка на документ
- ❌ `EnumRef.<ИмяПеречисления>` - ссылка на перечисление
- ❌ Составные типы (несколько типов в одном свойстве)
- ❌ Характеристики типов (длина строки, точность числа, квалификаторы)

## Примеры ссылочных свойств в 1С

### Пример 1: Реквизит справочника с типом "Ссылка на справочник"

**XML (Designer format):**
```xml
<Attribute>
  <Properties>
    <Name>Владелец</Name>
    <Synonym>
      <v8:item>
        <v8:lang>ru</v8:lang>
        <v8:content>Владелец</v8:content>
      </v8:item>
    </Synonym>
    <Type>
      <v8:Type>CatalogRef.Контрагенты</v8:Type>
    </Type>
  </Properties>
</Attribute>
```

**Как это выглядит в TreeNode.properties:**
```typescript
{
  Name: "Владелец",
  Synonym: "Владелец",
  Type: "CatalogRef.Контрагенты"  // или может быть объект
}
```

### Пример 2: Составной тип

**XML:**
```xml
<Type>
  <v8:Type>CatalogRef.Номенклатура</v8:Type>
  <v8:Type>CatalogRef.Услуги</v8:Type>
  <v8:Type>DocumentRef.ЗаказКлиента</v8:Type>
</Type>
```

**Как это может выглядеть в TreeNode.properties:**
```typescript
{
  Type: ["CatalogRef.Номенклатура", "CatalogRef.Услуги", "DocumentRef.ЗаказКлиента"]
  // или
  Type: {
    types: ["CatalogRef.Номенклатура", "CatalogRef.Услуги", "DocumentRef.ЗаказКлиента"]
  }
}
```

### Пример 3: Строка с квалификаторами

**XML:**
```xml
<Type>
  <v8:Type>xs:string</v8:Type>
  <v8:StringQualifiers>
    <v8:Length>100</v8:Length>
    <v8:AllowedLength>Variable</v8:AllowedLength>
  </v8:StringQualifiers>
</Type>
```

**Как это может выглядеть в TreeNode.properties:**
```typescript
{
  Type: {
    type: "string",
    length: 100,
    allowedLength: "Variable"
  }
}
```

## Вопросы для обсуждения

### 1. Входит ли поддержка ссылочных типов в текущую спецификацию?

**Анализ текущей спецификации:**

В `requirements.md` нет явного упоминания ссылочных типов. Требования говорят только о:
- Текстовых полях для строк (Requirement 3.2)
- Чекбоксах для boolean (Requirement 3.3)
- Number input для чисел (Requirement 3.4)

**Вывод:** ❌ Ссылочные типы НЕ входят в текущую спецификацию `metadata-properties-editor`

### 2. Должны ли мы добавить поддержку ссылочных типов?

**Аргументы ЗА:**
- ✅ Ссылочные типы - это основа 1С, они встречаются в большинстве реквизитов
- ✅ Без них редактор свойств будет неполным
- ✅ Пользователи ожидают видеть и редактировать типы данных
- ✅ В другой спецификации (`metadata-object-properties-panel`) это уже упомянуто

**Аргументы ПРОТИВ:**
- ❌ Это значительно усложнит реализацию
- ❌ Нужен UI для выбора типа из списка (dropdown, autocomplete)
- ❌ Нужна валидация существования ссылочных объектов
- ❌ Составные типы требуют сложного UI (multi-select)
- ❌ Выходит за рамки текущей спецификации (scope creep)

### 3. Как должны отображаться ссылочные типы?

**Вариант A: Только для чтения (read-only)**
```typescript
// Простое текстовое поле, disabled
<input type="text" value="CatalogRef.Контрагенты" disabled />
```
- ✅ Просто реализовать
- ✅ Не требует валидации
- ❌ Нельзя редактировать

**Вариант B: Текстовое поле с валидацией**
```typescript
// Можно редактировать, но с валидацией формата
<input type="text" value="CatalogRef.Контрагенты" />
// Валидация: проверка формата "TypeRef.ObjectName"
```
- ✅ Относительно просто
- ✅ Можно редактировать
- ❌ Легко ввести некорректное значение
- ❌ Нет проверки существования объекта

**Вариант C: Dropdown с автодополнением**
```typescript
// Select с поиском по доступным объектам
<select>
  <option>CatalogRef.Контрагенты</option>
  <option>CatalogRef.Номенклатура</option>
  ...
</select>
```
- ✅ Удобно для пользователя
- ✅ Гарантирует корректные значения
- ❌ Сложно реализовать
- ❌ Нужен список всех доступных объектов
- ❌ Как обрабатывать составные типы?

**Вариант D: Специальный редактор типов**
```typescript
// Кнопка "Edit Type" открывает модальное окно
<button>Edit Type: CatalogRef.Контрагенты</button>
// Модальное окно с деревом типов, multi-select для составных типов
```
- ✅ Максимально функционально
- ✅ Поддержка составных типов
- ❌ Очень сложно реализовать
- ❌ Требует отдельного UI компонента

### 4. Как обрабатывать составные типы?

**Текущая проблема:**
```typescript
// Как отобразить это?
Type: ["CatalogRef.Номенклатура", "CatalogRef.Услуги", "DocumentRef.ЗаказКлиента"]
```

**Варианты:**
1. **Строка через запятую** (простой вариант)
   ```
   CatalogRef.Номенклатура, CatalogRef.Услуги, DocumentRef.ЗаказКлиента
   ```
   - ✅ Просто отобразить
   - ❌ Сложно редактировать
   - ❌ Нужен парсинг строки

2. **Список с кнопками добавления/удаления** (сложный вариант)
   ```
   [CatalogRef.Номенклатура] [x]
   [CatalogRef.Услуги] [x]
   [DocumentRef.ЗаказКлиента] [x]
   [+ Add Type]
   ```
   - ✅ Удобно редактировать
   - ❌ Сложно реализовать
   - ❌ Много UI кода

3. **JSON строка** (технический вариант)
   ```json
   ["CatalogRef.Номенклатура", "CatalogRef.Услуги"]
   ```
   - ✅ Точное представление
   - ❌ Неудобно для пользователя
   - ❌ Требует знания JSON

## Рекомендации

### Для текущей спецификации (metadata-properties-editor)

**Рекомендация: Вариант A - Read-only для сложных типов**

```typescript
function detectPropertyType(value: unknown): PropertyType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') {
    // Проверка на ссылочный тип
    if (value.match(/^(Catalog|Document|Enum|ChartOfCharacteristicTypes)Ref\./)) {
      return 'reference'; // Новый тип
    }
    return 'string';
  }
  if (Array.isArray(value)) {
    return 'composite'; // Составной тип
  }
  if (typeof value === 'object' && value !== null) {
    return 'complex'; // Сложный объект (с квалификаторами)
  }
  return 'unknown';
}
```

**Рендеринг:**
```typescript
function renderPropertyInput(name: string, value: any, readOnly: boolean): string {
  const propertyType = detectPropertyType(value);
  
  switch (propertyType) {
    case 'boolean':
      return `<input type="checkbox" ${value ? 'checked' : ''} ${readOnly ? 'disabled' : ''} />`;
    
    case 'number':
      return `<input type="number" value="${value}" ${readOnly ? 'disabled' : ''} />`;
    
    case 'string':
      return `<input type="text" value="${value}" ${readOnly ? 'disabled' : ''} />`;
    
    case 'reference':
      // Ссылочный тип - только для чтения
      return `<input type="text" value="${value}" disabled title="Reference type (read-only)" />`;
    
    case 'composite':
      // Составной тип - отображаем как строку через запятую
      const types = Array.isArray(value) ? value.join(', ') : String(value);
      return `<input type="text" value="${types}" disabled title="Composite type (read-only)" />`;
    
    case 'complex':
      // Сложный объект - отображаем как JSON
      return `<textarea disabled title="Complex type (read-only)">${JSON.stringify(value, null, 2)}</textarea>`;
    
    default:
      return `<input type="text" value="${value}" ${readOnly ? 'disabled' : ''} />`;
  }
}
```

**Преимущества этого подхода:**
- ✅ Минимальные изменения в текущей реализации
- ✅ Не ломает существующую функциональность
- ✅ Пользователи видят ссылочные типы
- ✅ Не требует сложной валидации
- ✅ Не выходит за рамки MVP

**Недостатки:**
- ❌ Нельзя редактировать ссылочные типы
- ❌ Ограниченная функциональность

### Для будущей версии

**Рекомендация: Отдельная спецификация для Type Editor**

Создать отдельную спецификацию `metadata-type-editor` с полноценным редактором типов:
- Dropdown с автодополнением для простых типов
- Multi-select для составных типов
- Редактор квалификаторов (длина, точность, и т.д.)
- Валидация существования ссылочных объектов
- Интеграция с metadata tree для получения списка доступных объектов

## Вопросы к пользователю

1. **Должны ли мы добавить поддержку ссылочных типов в текущую спецификацию?**
   - Да, добавить read-only отображение (рекомендуется)
   - Да, добавить полноценное редактирование (сложно)
   - Нет, оставить как есть (только string/boolean/number)
   - Создать отдельную спецификацию для Type Editor

2. **Если добавлять, то в каком объеме?**
   - Минимум: read-only отображение ссылочных типов
   - Средний: текстовое поле с валидацией формата
   - Максимум: dropdown с автодополнением и multi-select

3. **Как обрабатывать составные типы?**
   - Строка через запятую (просто)
   - JSON строка (технично)
   - Список с кнопками (сложно)
   - Отдельный редактор (очень сложно)

4. **Приоритет этой функциональности?**
   - Критично - нужно сейчас
   - Важно - можно добавить после MVP
   - Низкий - можно отложить на будущее

## Предложение по реализации

### Фаза 1: Минимальная поддержка (для текущей спецификации)

**Изменения в Task 3:**
- Добавить определение типов: `reference`, `composite`, `complex`
- Рендерить эти типы как read-only поля
- Добавить tooltip с пояснением "Read-only"

**Изменения в валидации:**
- Не валидировать read-only поля
- Пропускать их при сохранении

**Оценка:** 1-2 часа работы

### Фаза 2: Полноценный Type Editor (отдельная спецификация)

**Новая спецификация:** `metadata-type-editor`

**Компоненты:**
- TypeEditorProvider - управление UI редактора типов
- TypeSelector - компонент выбора типа
- TypeValidator - валидация типов
- MetadataRegistry - реестр доступных объектов

**Оценка:** 2-3 дня работы

## Решение

**Ожидаем решения пользователя:**
- Какой вариант выбрать?
- Какой объем функциональности нужен?
- Когда это должно быть реализовано?
