import { createExecOutputTool, createWorkspaceTools, type RegisteredTool } from '../src/index.js';
const reader: RegisteredTool = createExecOutputTool({ execLogDir: '/private/session/exec' });
await createWorkspaceTools('/workspace', { execLogDir: '/private/session/exec' });
void reader;
// @ts-expect-error A private log scope is required.
createExecOutputTool();
// @ts-expect-error Scope must be a path string.
createExecOutputTool({ execLogDir: {} });
