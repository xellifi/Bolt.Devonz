/**
 * @module local-filesystem
 * Server-side filesystem implementation using Node.js native `fs` module.
 *
 * All operations are scoped to a project directory. Paths are resolved
 * relative to the project root and validated against traversal attacks.
 *
 * @remarks This module is SERVER-ONLY — it imports `node:fs/promises` and
 * `node:path` which are not available in the browser.
 */

import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import type { RuntimeFileSystem, DirEntry, FileStat, WatchEvent, WatchCallback, Disposer } from './runtime-provider';
import { isSafePath } from './runtime-provider';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('LocalFileSystem');

/*
 * Inline screenshot capture script — injected into generated app's index.html
 * so the preview iframe can respond to CAPTURE_SCREENSHOT_REQUEST messages.
 */
const CAPTURE_MARKER_START = '<!-- devonz:capture-start -->';
const CAPTURE_MARKER_END = '<!-- devonz:capture-end -->';

const CAPTURE_SCRIPT = `${CAPTURE_MARKER_START}<script>(function(){var L=false,G=false,C=[];function lh(cb){if(L&&window.html2canvas){cb(window.html2canvas);return}C.push(cb);if(G)return;G=true;var s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";s.async=true;s.onload=function(){L=true;G=false;while(C.length)C.shift()(window.html2canvas)};s.onerror=function(){G=false;while(C.length)C.shift()(null)};document.head.appendChild(s)}window.addEventListener("message",function(e){if(e.data&&e.data.type==="CAPTURE_SCREENSHOT_REQUEST"){var rid=e.data.requestId,o=e.data.options||{},mw=o.width||960,mh=o.height||600;lh(function(h2c){if(!h2c){window.parent.postMessage({type:"PREVIEW_SCREENSHOT_RESPONSE",requestId:rid,dataUrl:"",isPlaceholder:true},"*");return}var fh=Math.min(Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,window.innerHeight),4000);h2c(document.body,{useCORS:true,allowTaint:true,backgroundColor:"#0d1117",scale:1,logging:false,width:window.innerWidth,height:fh,windowHeight:fh}).then(function(cv){var r=Math.min(mw/cv.width,mh/cv.height,1),tw=Math.round(cv.width*r),th=Math.round(cv.height*r),tc=document.createElement("canvas");tc.width=tw;tc.height=th;var cx=tc.getContext("2d");if(cx){cx.drawImage(cv,0,0,cv.width,cv.height,0,0,tw,th);window.parent.postMessage({type:"PREVIEW_SCREENSHOT_RESPONSE",requestId:rid,dataUrl:tc.toDataURL("image/jpeg",0.85),isPlaceholder:false},"*")}}).catch(function(){window.parent.postMessage({type:"PREVIEW_SCREENSHOT_RESPONSE",requestId:rid,dataUrl:"",isPlaceholder:true},"*")})})}})})();</script>${CAPTURE_MARKER_END}`;

/** Regex to match the injected capture block (including newlines). */
const CAPTURE_BLOCK_RE = new RegExp(
  `\\s*${CAPTURE_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${CAPTURE_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  'g',
);

/** Check if a path is an index.html entry point. */
function isIndexHtml(filePath: string): boolean {
  const base = nodePath.basename(filePath);
  return base === 'index.html';
}

/** Strip the injected capture block from HTML content. */
function stripCaptureScript(html: string): string {
  return html.replace(CAPTURE_BLOCK_RE, '');
}

/** Inject the capture script into HTML content (before </head> or </body>). */
function injectCaptureScript(html: string): string {
  // Remove any existing injection first
  let clean = stripCaptureScript(html);

  // Inject before </head> if present, otherwise before </body>, otherwise append
  if (clean.includes('</head>')) {
    clean = clean.replace('</head>', `${CAPTURE_SCRIPT}\n</head>`);
  } else if (clean.includes('</body>')) {
    clean = clean.replace('</body>', `${CAPTURE_SCRIPT}\n</body>`);
  } else {
    clean += `\n${CAPTURE_SCRIPT}`;
  }

  return clean;
}

/**
 * Node.js native filesystem implementation for local project execution.
 *
 * Every path operation:
 * 1. Validates the path is safe (no traversal)
 * 2. Resolves it against the project root
 * 3. Performs the native fs operation
 */
export class LocalFileSystem implements RuntimeFileSystem {
  readonly #root: string;

  constructor(projectRoot: string) {
    this.#root = nodePath.resolve(projectRoot);
  }

  /** Resolve a relative path to an absolute path within the project root. */
  #resolve(relativePath: string): string {
    if (!isSafePath(relativePath)) {
      throw new Error(`Path traversal rejected: ${relativePath}`);
    }

    const resolved = nodePath.resolve(this.#root, relativePath);

    // Double-check: resolved path must be within root
    if (!resolved.startsWith(this.#root)) {
      throw new Error(`Path escapes project boundary: ${relativePath}`);
    }

    return resolved;
  }

  async readFile(path: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    const resolved = this.#resolve(path);
    const content = await fs.readFile(resolved, { encoding });

    // Strip injected capture script so editor/git see clean content
    if (isIndexHtml(path) && content.includes(CAPTURE_MARKER_START)) {
      return stripCaptureScript(content);
    }

    return content;
  }

  async readFileRaw(path: string): Promise<Uint8Array> {
    const resolved = this.#resolve(path);
    const buffer = await fs.readFile(resolved);

    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.#resolve(path);
    const dir = nodePath.dirname(resolved);

    // Auto-create parent directories
    await fs.mkdir(dir, { recursive: true });

    if (content instanceof Uint8Array) {
      await fs.writeFile(resolved, content);
    } else {
      // Inject capture script into index.html so the preview iframe can take screenshots
      const finalContent = isIndexHtml(path) ? injectCaptureScript(content) : content;
      await fs.writeFile(resolved, finalContent, 'utf-8');
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const resolved = this.#resolve(path);
    await fs.mkdir(resolved, { recursive: options?.recursive ?? false });
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const resolved = this.#resolve(path);
    const entries = await fs.readdir(resolved, { withFileTypes: true });

    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  }

  async stat(path: string): Promise<FileStat> {
    const resolved = this.#resolve(path);
    const stats = await fs.stat(resolved);

    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      size: stats.size,
      mtime: stats.mtime.toISOString(),
    };
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const resolved = this.#resolve(path);

    await fs.rm(resolved, {
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    });
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.#resolve(path);

    try {
      await fs.access(resolved);
      return true;
    } catch {
      return false;
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const resolvedOld = this.#resolve(oldPath);
    const resolvedNew = this.#resolve(newPath);

    // Auto-create destination parent directory
    const destDir = nodePath.dirname(resolvedNew);
    await fs.mkdir(destDir, { recursive: true });

    await fs.rename(resolvedOld, resolvedNew);
  }

  /**
   * Watch for file-system changes using Node.js `fs.watch` (recursive).
   *
   * @remarks Uses native `fs.watch` with `{ recursive: true }` which is
   * supported on macOS and Windows. On Linux, recursive watching requires
   * `chokidar` — we'll add that dependency in Phase 2 if needed.
   * For Phase 1 this provides basic watch capability.
   */
  watch(glob: string, callback: WatchCallback): Disposer {
    const watchers: FSWatcher[] = [];

    // Buffer events to avoid flooding the callback
    let pending: WatchEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const FLUSH_DELAY = 100;

    const flush = () => {
      if (pending.length > 0) {
        const batch = [...pending];
        pending = [];
        callback(batch);
      }

      flushTimer = null;
    };

    const scheduleFlush = () => {
      if (flushTimer === null) {
        flushTimer = setTimeout(flush, FLUSH_DELAY);
      }
    };

    try {
      const watcher = fsWatch(this.#root, { recursive: true }, (eventType, filename) => {
        if (!filename) {
          return;
        }

        // Normalize path separators
        const normalizedPath = filename.replace(/\\/g, '/');

        // Skip node_modules, .git, and other noisy directories
        if (
          normalizedPath.startsWith('node_modules/') ||
          normalizedPath.startsWith('.git/') ||
          normalizedPath.includes('/node_modules/') ||
          normalizedPath.includes('/.git/')
        ) {
          return;
        }

        if (glob !== '**/*' && glob !== '*') {
          // Basic extension matching: `*.ts` → ends with .ts
          if (glob.startsWith('*.')) {
            const ext = glob.slice(1);

            if (!normalizedPath.endsWith(ext)) {
              return;
            }
          }
        }

        const watchEvent: WatchEvent = {
          type: eventType === 'rename' ? 'add' : 'change',
          path: normalizedPath,
        };

        pending.push(watchEvent);
        scheduleFlush();
      });

      watchers.push(watcher);
    } catch (error) {
      logger.warn('Failed to start file watcher:', error);
    }

    return () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }

      for (const watcher of watchers) {
        watcher.close();
      }
    };
  }
}
