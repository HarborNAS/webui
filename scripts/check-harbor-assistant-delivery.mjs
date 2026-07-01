import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};
const includes = (path, text) => read(path).includes(text);
const replacementsFor = (config) => new Map((config?.fileReplacements ?? []).map((item) => [item.replace, item.with]));
const listFiles = (directory) => {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = `${directory}/${entry.name}`;
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
};

const packageJson = JSON.parse(read('package.json'));
const angularJson = JSON.parse(read('angular.json'));
const buildConfigurations = angularJson.projects['truenas-scale-ui'].architect.build.configurations;
const productionConfig = buildConfigurations.production;
const harbornaviBuildConfig = buildConfigurations['harbornavi-k3'];
const nexusBuildConfig = buildConfigurations['harboros-nexus'];

if (!packageJson.scripts['build:harbornavi-k3']) {
  fail('Missing build:harbornavi-k3 package script.');
}

if (!packageJson.scripts['build:harboros-nexus']) {
  fail('Missing build:harboros-nexus package script.');
} else {
  const nexusScript = packageJson.scripts['build:harboros-nexus'];
  if (!nexusScript.includes('--configuration harboros-nexus')) {
    fail('build:harboros-nexus must use the harboros-nexus Angular configuration.');
  }
  if (nexusScript.includes('harbornavi-k3')) {
    fail('build:harboros-nexus must not reuse the HarborNavi/K3 minimal profile.');
  }
}

if (!harbornaviBuildConfig) {
  fail('Missing Angular harbornavi-k3 build configuration.');
} else {
  if (harbornaviBuildConfig.tsConfig !== 'src/tsconfig.harbornavi.app.json') {
    fail('HarborNavi build must use src/tsconfig.harbornavi.app.json.');
  }

  const replacements = replacementsFor(harbornaviBuildConfig);
  const expected = new Map([
    ['src/app/app.component.ts', 'src/app/app.component.harbornavi.ts'],
    ['src/app/app.routes.ts', 'src/app/app.routes.harbornavi.ts'],
    ['src/main.ts', 'src/main.harbornavi.ts'],
    [
      'src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.ts',
      'src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.harbornavi.ts',
    ],
    [
      'src/app/modules/page-header/page-title-header/page-header.component.ts',
      'src/app/modules/page-header/page-title-header/page-header.component.harbornavi.ts',
    ],
    [
      'src/app/pages/file-manager/folder-picker-dialog/folder-picker-dialog.component.ts',
      'src/app/pages/file-manager/folder-picker-dialog/folder-picker-dialog.component.harbornavi.ts',
    ],
  ]);
  for (const [replace, withPath] of expected) {
    if (replacements.get(replace) !== withPath) {
      fail(`Missing HarborNavi file replacement: ${replace} -> ${withPath}`);
    }
  }
}

if (!nexusBuildConfig) {
  fail('Missing Angular harboros-nexus build configuration.');
} else {
  if (nexusBuildConfig.tsConfig) {
    fail('Nexus HarborOS build must keep the default full-shell tsConfig.');
  }

  const nexusReplacements = replacementsFor(nexusBuildConfig);
  const expected = new Map([
    ['src/environments/environment.ts', 'src/environments/environment.prod.ts'],
    [
      'src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.ts',
      'src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.harboros-nexus.ts',
    ],
  ]);
  if (nexusReplacements.size !== expected.size) {
    fail('Nexus HarborOS build may only replace environment and Harbor Assistant API prefix files.');
  }
  for (const [replace, withPath] of expected) {
    if (nexusReplacements.get(replace) !== withPath) {
      fail(`Missing Nexus HarborOS file replacement: ${replace} -> ${withPath}`);
    }
  }

  for (const forbiddenReplacement of [
    'src/main.ts',
    'src/app/app.component.ts',
    'src/app/app.routes.ts',
    'src/app/modules/page-header/page-title-header/page-header.component.ts',
    'src/app/pages/file-manager/folder-picker-dialog/folder-picker-dialog.component.ts',
  ]) {
    if (nexusReplacements.has(forbiddenReplacement)) {
      fail(`Nexus HarborOS build must not replace full-shell interface file: ${forbiddenReplacement}`);
    }
  }
}

if (productionConfig && replacementsFor(productionConfig).has('src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.ts')) {
  fail('Default production build must not replace the Harbor Assistant API prefix without explicit HarborOS approval.');
}

const harbornaviRoutes = read('src/app/app.routes.harbornavi.ts');
const harbornaviMain = read('src/main.harbornavi.ts');
for (const forbidden of ['AuthGuard', 'WebSocketConnectionGuard', 'SigninComponent', 'PingService', 'ApiService', 'rootEffects', 'ServiceWorkerService', '/api/current', '192.168.3.82']) {
  if (harbornaviRoutes.includes(forbidden) || harbornaviMain.includes(forbidden)) {
    fail(`HarborNavi app profile must not depend on ${forbidden}.`);
  }
}

if (!includes('src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.harbornavi.ts', '/api/beacon')) {
  fail('HarborNavi API prefix must use /api/beacon.');
}

if (!includes('src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.ts', '/api/harbor-beacon')) {
  fail('Default Harbor Assistant API prefix must remain /api/harbor-beacon.');
}

if (!includes('src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.harboros-nexus.ts', '/api/beacon')) {
  fail('Nexus HarborOS API prefix must use /api/beacon.');
}

const appRoutes = read('src/app/app.routes.ts');
const adminRoutes = read('src/app/admin.routes.ts');
for (const required of [
  "loadChildren: () => import('app/admin.routes')",
  'WebSocketConnectionGuard',
  'SigninComponent',
]) {
  if (!appRoutes.includes(required)) {
    fail(`Full HarborOS app route must keep ${required}.`);
  }
}
for (const required of [
  'AuthGuardService',
  'TranslationsLoadedGuard',
  'WebSocketConnectionGuard',
  "path: 'harbor-assistant'",
  "loadChildren: () => import('app/pages/harbor-assistant/harbor-assistant.routes')",
]) {
  if (!adminRoutes.includes(required)) {
    fail(`Full HarborOS admin route must keep ${required}.`);
  }
}

const assistantComponent = read('src/app/pages/harbor-assistant/harbor-assistant.component.ts');
const assistantTemplate = read('src/app/pages/harbor-assistant/harbor-assistant.component.html');
if (assistantComponent.includes('app/pages/file-manager/folder-picker-dialog/folder-picker-dialog.component')) {
  fail('Harbor Assistant must not import the global File Manager folder picker.');
}
if (!assistantComponent.includes('HarborAssistantFolderBrowserDialogComponent')) {
  fail('Harbor Assistant must use its own folder browser dialog.');
}
for (const required of [
  "id: 'search'",
  "id: 'camera'",
  "id: 'messages'",
  "id: 'home-assistant'",
  "id: 'settings'",
  'Event intelligence',
  'Message connections',
  'Home Assistant',
]) {
  if (!assistantComponent.includes(required) && !assistantTemplate.includes(required)) {
    fail(`HarborNavi K3 Assistant must keep full product surface: ${required}`);
  }
}

for (const forbidden of ['k3-direct-72h-readiness', 'Start 72h', 'Start 4h', 'operator supervisor']) {
  for (const path of [
    'src/app/pages/harbor-assistant/harbor-assistant.component.html',
    'src/assets/i18n/en.json',
    'src/assets/i18n/zh-hans.json',
  ]) {
    if (includes(path, forbidden)) {
      fail(`${path} must not contain customer-visible ${forbidden}.`);
    }
  }
}

const packaging = read('scripts/harbornavi-k3/build-deb.sh');
for (const required of [
  'Package: $package_name',
  '/usr/share/harbornavi/webui',
  '/etc/nginx/conf.d/harbornavi-webui.conf',
  'location /api/beacon/',
  'proxy_pass http://127.0.0.1:4174',
  'location /api/harbor-gate/',
  'proxy_pass http://127.0.0.1:8787',
]) {
  if (!packaging.includes(required)) {
    fail(`HarborNavi package script missing: ${required}`);
  }
}

for (const forbidden of ['/api/harbor-assistant', '192.168.3.82']) {
  for (const path of [
    'src/app/app.routes.harbornavi.ts',
    'src/app/app.component.harbornavi.ts',
    'src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.harbornavi.ts',
    'src/app/pages/harbor-assistant/services/harbor-assistant-api-prefix.harboros-nexus.ts',
    'src/app/pages/harbor-assistant/services/harbor-assistant-api.service.ts',
    'src/app/pages/harbor-assistant/shared/harbor-assistant-content-api.service.ts',
    'src/app/pages/file-manager/folder-picker-dialog/folder-picker-dialog.component.harbornavi.ts',
    'scripts/harbornavi-k3/build-deb.sh',
    'docs/harbornavi-k3-webui.md',
  ]) {
    if (includes(path, forbidden)) {
      fail(`${path} must not contain ${forbidden}.`);
    }
  }
}

if (process.env.HARBOR_ASSISTANT_CHECK_NEXUS_DIST === '1') {
  const distFiles = listFiles('dist')
    .filter((path) => /\.(js|mjs|html|css|map)$/.test(path));
  if (distFiles.length === 0) {
    fail('Nexus dist check requested, but dist/ has no browser assets.');
  } else {
    const distSource = distFiles.map((path) => read(path)).join('\n');
    if (!distSource.includes('/api/beacon')) {
      fail('Nexus dist must contain /api/beacon API references.');
    }
    for (const forbidden of ['/api/harbor-assistant', 'k3-direct-72h-readiness', 'Start 72h', 'Start 4h', 'operator supervisor']) {
      if (distSource.includes(forbidden)) {
        fail(`Nexus dist must not contain ${forbidden}.`);
      }
    }
  }
}

if (!process.exitCode) {
  console.log('Harbor Assistant HarborNavi/K3 and Nexus HarborOS delivery checks passed.');
}
