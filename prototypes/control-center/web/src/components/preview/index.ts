/** Unified file preview: component, renderer registry and the dock opener. */
export { FilePreview, type FilePreviewProps } from './FilePreview'
export { openFilePreview } from './open'
export { previewSpec, isRichPreview, toWorkspacePath, resolveRelative, sizeVerdict, type PreviewKind, type PreviewSpec } from './registry'
