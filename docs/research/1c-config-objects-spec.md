# Спецификация объектов конфигурации (выгрузка Designer) — рабочие заметки CDT

**Нормативный источник в коде:** `ROOT_TAGS_WITHOUT_CHILDOBJECTS` и комментарии в [`src/utils/XMLWriter.ts`](../../src/utils/XMLWriter.ts). При расхождении правьте код и синхронизируйте этот файл.

Документ описывает ограничения, от которых зависят **запись XML** и **матрица ibcmd**: какие корневые теги объектов **не** содержат контейнера `ChildObjects` в типичной выгрузке Designer.

## 6. Типы без ChildObjects

Список имён тегов (как в XML), синхронизирован с `ROOT_TAGS_WITHOUT_CHILDOBJECTS`:

- `CommonModule`, `Role`, `SessionParameter`, `FunctionalOption`, `FunctionalOptionsParameter`, `CommandGroup`, `Interface`, `Style`, `EventSubscription`, `DefinedType`, `Language`, `CommonPicture`, `CommonAttribute`, `CommonForm`, `Form`, `WSReference`, `StyleItem`, `XDTOPackage`, `DocumentNumerator`, `ScheduledJob`, `Constant`

### 6.3 Форма (`Form`)

Встроенная форма объекта: последовательность узлов в файле должна соответствовать ожиданиям платформы; **пустой** искусственно добавленный `ChildObjects` ломает импорт (`ibcmd config import`). См. тесты `xmlWriter.test.ts` и комментарии в `XMLWriter.ts`.

## Прочие отсылки в коде

- `internalInfoGenerator.ts` — §29 (внутренние поля метаданных); детали в исходнике.
