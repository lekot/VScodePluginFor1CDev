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
  if (options.cspSource) {
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
