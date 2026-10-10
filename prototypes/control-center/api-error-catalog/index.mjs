// Merged zh -> en catalog of API error messages; conflicting duplicates across modules are reported, not silently overridden.
import maintenance from './maintenance.mjs';
import capability from './capability.mjs';
import configuration from './configuration.mjs';
import routes from './routes.mjs';
import memory from './memory.mjs';
import evolution from './evolution.mjs';
import project from './project.mjs';
import session from './session.mjs';
import workspace from './workspace.mjs';
import misc from './misc.mjs';
import sdk from './sdk.mjs';

export const CATALOG_MODULES = { maintenance, capability, configuration, routes, memory, evolution, project, session, workspace, misc, sdk };
export const catalogConflicts = [];
const merged = {};
for (const [name, entries] of Object.entries(CATALOG_MODULES)) for (const [zh, en] of Object.entries(entries)) {
  if (zh in merged && merged[zh] !== en) catalogConflicts.push({ zh, module: name, kept: merged[zh], dropped: en });
  else merged[zh] ??= en;
}
export default Object.freeze(merged);
