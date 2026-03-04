/**
 * @fileoverview Barrel file for all resource definitions.
 * Re-exports all resource definitions and provides an array for easy iteration.
 * @module src/mcp-server/resources/definitions
 */

import { databaseInfoResource } from './database-info.resource.js';

/**
 * An array containing all resource definitions for easy iteration.
 */
export const allResourceDefinitions = [databaseInfoResource] as const;
