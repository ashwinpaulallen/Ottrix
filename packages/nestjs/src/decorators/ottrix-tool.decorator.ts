import { SetMetadata } from '@nestjs/common';

/** Metadata key for classes decorated with {@link OttrixTool}. */
export const OTTRIX_TOOL_METADATA = Symbol('OTTRIX_TOOL');

/**
 * Mark an injectable class as an Ottrix tool provider.
 *
 * Register the class via {@link OttrixModule.forFeature} `tools` option.
 * The class must implement {@link OttrixToolFactory}.
 */
export function OttrixTool(): ClassDecorator {
  return SetMetadata(OTTRIX_TOOL_METADATA, true);
}
