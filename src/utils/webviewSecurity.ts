import { randomBytes } from 'crypto';

/**
 * Generate a cryptographically secure random base64url nonce for Webview CSP.
 */
export function createNonce(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Configuration options for generating a Content-Security-Policy header/meta tag.
 */
export interface WebviewCspOptions {
  /** Random nonce for script execution */
  nonce?: string;
  /** VS Code webview cspSource (e.g. vscode-webview:) */
  cspSource?: string;
  /**
   * Allow 'unsafe-inline' for style-src.
   * Documented functional exception: VS Code webviews frequently manipulate
   * inline styles dynamically via DOM elements (e.g. element.style.display).
   */
  allowUnsafeInlineStyles?: boolean;
  /** Allowed image sources (e.g. data:, cspSource) */
  imgSources?: string[];
  /** Explicit style sources. If omitted, defaults to [cspSource] when cspSource is set. */
  styleSources?: string[];
  /** Allowed font sources */
  fontSources?: string[];
  /** Enforce base-uri 'none' (defaults to true) */
  baseUriNone?: boolean;
  /** Enforce form-action 'none' (defaults to true) */
  formActionNone?: boolean;
  /** Additional custom directives */
  extraDirectives?: Record<string, string[]>;
}

/**
 * Build a robust, defense-in-depth Content-Security-Policy string.
 *
 * Requirements:
 * - default-src 'none';
 * - script-src 'nonce-<nonce>' (never 'unsafe-inline');
 * - style-src 'nonce-<nonce>' or 'unsafe-inline' (documented exception);
 * - minimal resource schemes (data:, cspSource);
 * - base-uri 'none'; form-action 'none'.
 */
export function buildWebviewCsp(options: WebviewCspOptions = {}): string {
  const directives: string[] = ["default-src 'none'"];

  if (options.nonce) {
    directives.push(`script-src 'nonce-${options.nonce}'`);
  }

  const styleParts: string[] = [];
  if (options.styleSources !== undefined) {
    styleParts.push(...options.styleSources);
  } else if (options.cspSource) {
    styleParts.push(options.cspSource);
  }
  if (options.allowUnsafeInlineStyles) {
    styleParts.push("'unsafe-inline'");
  } else if (options.nonce) {
    styleParts.push(`'nonce-${options.nonce}'`);
  }
  if (styleParts.length > 0) {
    directives.push(`style-src ${styleParts.join(' ')}`);
  }

  if (options.imgSources && options.imgSources.length > 0) {
    directives.push(`img-src ${options.imgSources.join(' ')}`);
  }

  if (options.fontSources && options.fontSources.length > 0) {
    directives.push(`font-src ${options.fontSources.join(' ')}`);
  }

  if (options.baseUriNone ?? true) {
    directives.push("base-uri 'none'");
  }

  if (options.formActionNone ?? true) {
    directives.push("form-action 'none'");
  }

  if (options.extraDirectives) {
    for (const [name, values] of Object.entries(options.extraDirectives)) {
      if (values.length > 0) {
        directives.push(`${name} ${values.join(' ')}`);
      }
    }
  }

  return directives.join('; ') + ';';
}

/**
 * Replace `${nonce}` placeholders in HTML templates with a fresh or specified nonce.
 */
export function applyNonceToHtml(html: string, nonce?: string): { html: string; nonce: string } {
  const effectiveNonce = nonce ?? createNonce();
  return {
    html: html.replace(/\$\{nonce\}/g, effectiveNonce),
    nonce: effectiveNonce,
  };
}

/**
 * Options for renderSecureWebview.
 */
export interface SecureWebviewRenderOptions {
  webview?: { cspSource: string };
  nonce?: string;
  csp?: WebviewCspOptions;
  substitutions?: Record<string, string>;
}

export interface SecureWebviewRenderResult {
  html: string;
  nonce: string;
  csp: string;
}

/**
 * Single security boundary for rendering webview HTML.
 * Applies CSP, nonce, cspSource, and optional substitutions to template HTML.
 */
export function renderSecureWebview(
  templateHtml: string,
  options: SecureWebviewRenderOptions = {}
): SecureWebviewRenderResult {
  const nonce = options.nonce ?? createNonce();
  const cspSource = options.csp?.cspSource ?? options.webview?.cspSource;

  const cspOptions: WebviewCspOptions = {
    nonce,
    baseUriNone: true,
    formActionNone: true,
    ...(cspSource ? { cspSource } : {}),
    ...options.csp,
  };
  if (options.csp?.nonce !== undefined) {
    cspOptions.nonce = options.csp.nonce;
  } else {
    cspOptions.nonce = nonce;
  }

  const csp = buildWebviewCsp(cspOptions);

  let html = templateHtml;

  // 1. Substitute CSP meta tag or placeholder
  if (html.includes('${csp}')) {
    html = html.split('${csp}').join(csp);
  } else {
    const cspMetaRegex = /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i;
    if (cspMetaRegex.test(html)) {
      html = html.replace(cspMetaRegex, `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
    } else {
      const headRegex = /<head\b[^>]*>/i;
      if (headRegex.test(html)) {
        html = html.replace(headRegex, (m) => `${m}\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
      } else {
        html = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n${html}`;
      }
    }
  }

  // 2. Substitute nonce placeholders
  html = html.split('${nonce}').join(nonce);

  // 3. Substitute cspSource placeholders
  if (cspSource) {
    html = html.split('${webview.cspSource}').join(cspSource);
    html = html.split('${cspSource}').join(cspSource);
  }

  // 4. Custom substitutions
  if (options.substitutions) {
    for (const [key, value] of Object.entries(options.substitutions)) {
      html = html.split(key).join(value);
    }
  }

  return { html, nonce, csp };
}

/**
 * Helper that returns just the rendered secure HTML string.
 */
export function renderSecureWebviewHtml(
  templateHtml: string,
  options: SecureWebviewRenderOptions = {}
): string {
  return renderSecureWebview(templateHtml, options).html;
}

