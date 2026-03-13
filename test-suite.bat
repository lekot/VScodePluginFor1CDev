@echo off
echo Compiling TypeScript with test config...
node node_modules/typescript/bin/tsc -p tsconfig.test.json
if %errorlevel% neq 0 exit /b %errorlevel%

echo Copying test fixtures...
xcopy /E /I /Y test\fixtures out\test\fixtures >nul

echo Running tests (parsers + utils; tree/integration require VS Code Test Runner)...
node node_modules/mocha/bin/mocha --ui tdd out/test/suite/designerParser.test.js out/test/suite/formatDetector.test.js out/test/suite/formXmlParser.test.js out/test/suite/metadataParser.test.js out/test/suite/xmlParser.test.js out/test/suite/xmlWriter.test.js out/test/suite/elementNameValidator.test.js out/test/suite/referenceFinder.test.js out/test/suite/elementOperations.test.js

echo Done!
