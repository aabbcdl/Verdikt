/**
 * Simple logger for Verdikt.
 *
 * Respects verbose mode from config.
 * Levels: info (always), debug (verbose only)
 */

import { getConfig } from "../config.js";

export function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

export function debug(msg: string): void {
  if (getConfig().verbose) {
    // eslint-disable-next-line no-console
    console.log(`[debug] ${msg}`);
  }
}

export function warn(msg: string): void {
  // eslint-disable-next-line no-console
  console.warn(`⚠️  ${msg}`);
}

export function error(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`❌ ${msg}`);
}
