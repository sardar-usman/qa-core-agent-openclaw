import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Framework zipper.
 *
 * Turns a scaffolded framework directory into either:
 *   - A `.zip` file on disk (used by the CLI path so the user can move the
 *     bundle around the filesystem), OR
 *   - A `Buffer` of zip bytes in memory (used by the WebSocket gateway path
 *     so the bytes can be base64-encoded and streamed to the UI for download).
 *
 * Implementation note: we shell out to the platform `zip` command via
 * `spawnSync` (no shell interpretation, no injection surface). This avoids
 * adding a new npm dependency for a feature we only need in one place.
 * The agent already assumes a Unix-like environment elsewhere (setup.sh,
 * gateway, playwright/.auth layout), so this is consistent.
 *
 * The `zip` flags used:
 *   -r   recurse into subdirectories
 *   -q   quiet (suppress per-file logging)
 *   -X   strip extra attributes (uid/gid/extended attrs) so the zip is
 *        reproducible across machines
 */

const MAX_ZIP_BYTES = 100 * 1024 * 1024; // 100 MB — pathological cap, real frameworks are <1 MB

export interface ZipResult {
  /** Absolute path to the .zip on disk. */
  zipPath: string;
  /** Size of the .zip in bytes. */
  sizeBytes: number;
}

/**
 * Zip a directory to disk. The resulting zip preserves the source directory
 * as its top-level folder (so unzipping it produces `srcDir-basename/...`,
 * not loose files dumped into cwd).
 */
export function zipFrameworkToFile(srcDir: string, destZipPath: string): ZipResult {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new Error(`Source is not a directory: ${srcDir}`);
  }
  // Overwrite any pre-existing zip rather than letting `zip` append into it.
  if (fs.existsSync(destZipPath)) fs.unlinkSync(destZipPath);

  const parent = path.dirname(path.resolve(srcDir));
  const base = path.basename(srcDir);

  const result = spawnSync('zip', ['-rqX', destZipPath, base], { cwd: parent, encoding: 'buffer' });
  if (result.error) {
    throw new Error(
      `Failed to invoke 'zip': ${result.error.message}. ` +
      `Is the 'zip' command available on this system?`,
    );
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8') ?? '';
    throw new Error(`zip exited with code ${result.status}. stderr: ${stderr}`);
  }
  if (!fs.existsSync(destZipPath)) {
    throw new Error(`zip reported success but no file at ${destZipPath}`);
  }
  const stats = fs.statSync(destZipPath);
  return { zipPath: destZipPath, sizeBytes: stats.size };
}

/**
 * Zip a directory and return the bytes as a Buffer. Used by the gateway
 * which then base64-encodes and streams over the WebSocket.
 *
 * Throws if the result would exceed `MAX_ZIP_BYTES` — that's a sanity cap
 * against pathological inputs, real generated frameworks are well under 1 MB.
 */
export function zipFrameworkToBuffer(srcDir: string): Buffer {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new Error(`Source is not a directory: ${srcDir}`);
  }
  const parent = path.dirname(path.resolve(srcDir));
  const base = path.basename(srcDir);

  // `zip -rqX -` writes the archive to stdout.
  const result = spawnSync('zip', ['-rqX', '-', base], {
    cwd: parent,
    maxBuffer: MAX_ZIP_BYTES,
  });
  if (result.error) {
    throw new Error(
      `Failed to invoke 'zip': ${result.error.message}. ` +
      `Is the 'zip' command available on this system?`,
    );
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8') ?? '';
    throw new Error(`zip exited with code ${result.status}. stderr: ${stderr}`);
  }
  if (!result.stdout || result.stdout.length === 0) {
    throw new Error('zip produced no output');
  }
  if (result.stdout.length > MAX_ZIP_BYTES) {
    throw new Error(`zip output (${result.stdout.length} bytes) exceeds MAX_ZIP_BYTES (${MAX_ZIP_BYTES})`);
  }
  return result.stdout;
}

/**
 * Convenience: zip a framework, base64-encode it, return the data URL form
 * the UI can drop into an `<a href=...>` to trigger a browser download.
 *
 * Output prefix is `data:application/zip;base64,` followed by the encoded
 * bytes. Total payload is ~33% larger than the raw zip — acceptable for
 * typical framework sizes (50–500 KB).
 */
export function zipFrameworkToDataUrl(srcDir: string): string {
  const buf = zipFrameworkToBuffer(srcDir);
  return 'data:application/zip;base64,' + buf.toString('base64');
}
