import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const config = JSON.parse(await fs.readFile('angular.json', 'utf8'));
const profiles = config.projects['truenas-scale-ui'].architect.build.configurations;
const prefixPath = 'src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.ts';
const replacements = profiles['harbornavi-k3'].fileReplacements;
assert.equal(profiles.production.fileReplacements.some((entry) => entry.replace === prefixPath), false);
const naviPrefix = replacements.find((entry) => entry.replace === prefixPath);
assert.ok(naviPrefix);
for (const entry of replacements) {
  await fs.access(entry.replace);
  await fs.access(entry.with);
}
async function loadPrefix(file) {
  const source = await fs.readFile(file, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
const nexus = await loadPrefix(prefixPath);
const navi = await loadPrefix(naviPrefix.with);
assert.equal(nexus.harborAssistantGateRequiresUserToken(), true);
assert.equal(nexus.harborAssistantGateApiUrl('/knowledge/search'), '/api/harbor-gate/api/beacon/knowledge/search');
assert.equal(nexus.harborAssistantSetupApiUrl('/status'), '/api/harbor-gate/api/setup/status');
assert.equal(navi.harborAssistantGateRequiresUserToken(), false);
assert.equal(navi.harborAssistantGateApiUrl('/knowledge/search'), '/api/beacon/knowledge/search');
assert.equal(navi.harborAssistantSetupApiUrl('/status'), '/api/setup/status');
console.log('Assistant profile contract passed: Nexus user proof; HarborNavi retains its own API/authentication boundary.');
