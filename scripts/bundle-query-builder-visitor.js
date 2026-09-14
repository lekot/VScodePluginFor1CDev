const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

function bundleQueryBuilderVisitor() {
  const rootDir = path.resolve(__dirname, '..');
  const entryPoint = path.join(rootDir, 'src', 'queryBuilder', 'sdbl', 'sdblAstVisitor.ts');
  const htmlPath = path.join(rootDir, 'src', 'queryBuilder', 'ui', 'queryBuilderWebview.html');

  if (!fs.existsSync(entryPoint)) {
    throw new Error(`Entry point not found: ${entryPoint}`);
  }
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Webview HTML not found: ${htmlPath}`);
  }

  const result = esbuild.buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'SdblAstVisitor',
    target: 'es2020',
    write: false,
  });

  let bundleJs = result.outputFiles[0].text.trim();
  bundleJs += '\nif (typeof window !== "undefined") { window.SdblAstVisitor = SdblAstVisitor; }\nif (typeof globalThis !== "undefined") { globalThis.SdblAstVisitor = SdblAstVisitor; }';
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  const startMarker = '/* SDBL_AST_VISITOR_BUNDLE_START */';
  const endMarker = '/* SDBL_AST_VISITOR_BUNDLE_END */';

  const startIndex = htmlContent.indexOf(startMarker);
  const endIndex = htmlContent.indexOf(endMarker);

  let newHtml;
  if (startIndex !== -1 && endIndex !== -1) {
    newHtml =
      htmlContent.substring(0, startIndex + startMarker.length) +
      '\n' +
      bundleJs +
      '\n' +
      htmlContent.substring(endIndex);
  } else {
    const scriptTag = '<script>';
    const scriptIndex = htmlContent.indexOf(scriptTag);
    if (scriptIndex === -1) {
      throw new Error(`Could not find <script> tag in ${htmlPath}`);
    }
    const insertPos = scriptIndex + scriptTag.length;
    newHtml =
      htmlContent.substring(0, insertPos) +
      '\n        ' +
      startMarker +
      '\n' +
      bundleJs +
      '\n        ' +
      endMarker +
      '\n' +
      htmlContent.substring(insertPos);
  }

  fs.writeFileSync(htmlPath, newHtml, 'utf8');
  console.log('[bundle-query-builder-visitor] Successfully updated queryBuilderWebview.html with bundled SdblAstVisitor.');
}

if (require.main === module) {
  bundleQueryBuilderVisitor();
}

module.exports = { bundleQueryBuilderVisitor };
