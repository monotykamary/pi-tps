// Offline Pi 1.0 SDK/bundle lifecycle, identity, loadout, nested-tool and renderer probe.
import assert from 'node:assert/strict';
import { findPackageJSON } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(join(tmpdir(), 'pi1-workflow-'));
const previousCwd = process.cwd();
const previousFetch = globalThis.fetch;
const environment = ['PI_CODING_AGENT_DIR', 'PI_SWARM_SPAWNED', 'MORPH_API_KEY'];
const previousEnv = Object.fromEntries(environment.map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = home;
process.env.PI_SWARM_SPAWNED = '1'; // Do not start the reason-harness service.
delete process.env.MORPH_API_KEY;
process.chdir(home); // Keep lifecycle aliases/session-id files in the disposable fixture.
globalThis.fetch = async () => new Response('', { status: 503 });
let session;
try {
  const host = process.env.PI1_HOST_PACKAGE;
  const hostEntry =
    process.env.PI1_HOST_ENTRY === 'bundle' ? 'dist/bundle/index.js' : 'dist/index.js';
  const sdk = await import(
    host
      ? pathToFileURL(join(host, hostEntry)).href
      : import.meta.resolve('@earendil-works/pi-coding-agent')
  );
  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    VERSION,
  } = sdk;
  assert.equal(VERSION, '1.0.0', 'actual executing Pi host');
  const localSdk = await import('@earendil-works/pi-coding-agent');
  assert.equal(localSdk.VERSION, '1.0.0', 'exact pinned development host');
  const aiPath = findPackageJSON(
    '@earendil-works/pi-ai/compat',
    pathToFileURL(join(sdk.getPackageDir(), 'package.json'))
  );
  const aiManifest = JSON.parse(await readFile(aiPath, 'utf8'));
  assert.equal(aiManifest.version, '1.0.0');
  const ai = await import(
    pathToFileURL(join(dirname(aiPath), aiManifest.exports['./compat'].import)).href
  );
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const name of [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    'typebox',
  ]) {
    assert.equal(manifest.dependencies?.[name], undefined, `${name}: never bundle host packages`);
    if (manifest.peerDependencies?.[name] !== undefined)
      assert.equal(manifest.peerDependencies[name], '*');
    if (manifest.devDependencies?.[name] !== undefined && name !== 'typebox')
      assert.equal(manifest.devDependencies[name], '1.0.0');
  }
  const identityPath = join(home, 'identity.ts');
  globalThis[Symbol.for('pi1.workflow.identity')] = sdk.AgentSession;
  await writeFile(
    identityPath,
    `import { AgentSession } from '@earendil-works/pi-coding-agent';
export default function () {
  if (AgentSession !== globalThis[Symbol.for('pi1.workflow.identity')]) throw new Error('Duplicate host constructor');
}`
  );
  const errors = [],
    events = [];
  let api;
  const settingsManager = SettingsManager.inMemory({
    packages: [root],
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: home,
    agentDir: home,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [identityPath],
    extensionFactories: [
      (pi) => {
        api = pi;
        for (const type of ['session_start', 'session_shutdown', 'tool_result'])
          pi.on(type, (event) => {
            events.push(event);
          });
        pi.registerTool({
          name: 'offline_native_probe',
          label: 'Offline probe',
          description: 'Native probe',
          exposure: 'model-only',
          parameters: { type: 'object', properties: {} },
          prepareLoadout: (loadout) => ({
            hiddenDeclarations: loadout.callable.map((tool) => tool.name),
          }),
          async execute(_id, _args, signal, _update, ctx) {
            assert(!ctx.tools.some((tool) => tool.name === 'offline_native_probe'));
            assert(ctx.tools.some((tool) => tool.name === 'read'));
            const result = await ctx.executeTool('read', { path: identityPath }, { signal });
            assert.equal(result.isError, false, JSON.stringify(result));
            assert(
              result.result.content.some(
                (block) =>
                  block.type === 'text' && block.text.includes('Duplicate host constructor')
              )
            );
            const invalid = await ctx.executeTool('read', {}, { signal });
            assert.equal(invalid.isError, true, 'native nested argument validation');
            return { content: [{ type: 'text', text: 'offline-native-ok' }], details: undefined };
          },
        });
      },
    ],
  });
  const faux = ai.fauxProvider({
    provider: 'pi1-workflow',
    api: 'pi1-workflow-api',
    models: [{ id: 'offline', name: 'Offline', reasoning: false }],
    tokenSize: { min: 100, max: 100 },
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(home, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  async function loadSession() {
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.warnings ?? [], []);
    assert(
      loaded.extensions.some((extension) => extension.resolvedPath.startsWith(root)),
      'manifest entrypoints load'
    );
    ({ session } = await createAgentSession({
      cwd: home,
      agentDir: home,
      resourceLoader,
      modelRuntime,
      model: modelRuntime.getModel('pi1-workflow', 'offline'),
      settingsManager,
      sessionManager: SessionManager.inMemory(home),
    }));
    session.extensionRunner.onError((error) => errors.push(error));
    await session.bindExtensions({});
    return loaded;
  }
  const loaded = await loadSession();
  const owned = loaded.extensions.filter((extension) => extension.resolvedPath.startsWith(root));
  const names = new Set();
  for (const extension of owned) {
    assert(
      extension.handlers.size + extension.commands.size + extension.tools.size > 0,
      'owned public registrations'
    );
    for (const [name, { definition }] of extension.tools) {
      assert.equal(definition.name, name);
      assert.equal(typeof definition.execute, 'function');
      assert.equal(typeof definition.parameters, 'object');
      assert(!names.has(name), `duplicate tool ${name}`);
      names.add(name);
      assert(session.getAllTools().some((tool) => tool.name === name));
    }
  }
  const command = {
    'pi-reason-harness': 'reason',
    'pi-recurse': 'recurse-status',
    '@monotykamary/pi-supervisor': 'supervise',
    '@monotykamary/pi-tps': 'tps-export',
    'pi-tps-web': 'tps-web',
    'pi-var': 'var',
  }[manifest.name];
  if (command)
    assert(session.extensionRunner.getRegisteredCommands().some((item) => item.name === command));
  faux.setResponses([
    (context) => {
      assert(
        ai.getCurrentTools(context.messages).some((tool) => tool.name === 'offline_native_probe')
      );
      assert(!ai.getCurrentTools(context.messages).some((tool) => tool.name === 'read'));
      const prompt = ai.getCurrentSystemPrompt(context.messages);
      if (manifest.name === 'pi-recurse') {
        assert(prompt.includes('Recursive Agent Context'));
        assert(
          context.messages.some(
            (message) =>
              message.role === 'system' &&
              message.sections?.recursion?.includes('Recursive Agent Context')
          ),
          'recursion remains a structured prompt section'
        );
      }
      if (manifest.name === 'pi-morph-plugin') {
        assert(prompt.includes('Morph remote tools are currently unavailable'));
        assert(
          context.messages.some(
            (message) =>
              message.role === 'system' &&
              message.sections?.morph?.includes('Morph remote tools are currently unavailable')
          ),
          'Morph routing remains a structured prompt section'
        );
      }
      return ai.fauxAssistantMessage(
        [ai.fauxToolCall('offline_native_probe', {}, { id: 'outer' })],
        { stopReason: 'toolUse' }
      );
    },
    ai.fauxAssistantMessage('offline workflow complete'),
  ]);
  await session.prompt('Verify this workflow locally without remote tools.');
  assert.equal(
    session.getLastAssistantText(),
    'offline workflow complete',
    JSON.stringify(session.messages.at(-1))
  );
  assert(
    events.some(
      (event) =>
        event.type === 'tool_result' &&
        event.parentToolCallId === 'outer' &&
        event.toolName === 'read'
    )
  );
  assert(
    !session.messages.some(
      (message) => message.role === 'toolResult' && message.toolName === 'read'
    )
  );
  assert(
    session.messages.find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'outer'
    )?.nestedCalls
  );
  if (manifest.name === '@monotykamary/pi-tps') {
    const telemetry = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === 'custom' && entry.customType === 'tps');
    assert.equal(telemetry.length, 2, 'one persisted telemetry record per real provider turn');
    assert(
      telemetry.every(
        (entry) => entry.data.model.provider === 'pi1-workflow' && entry.data.tokens.output > 0
      )
    );
  }
  let renderers = 0;
  if (manifest.name === 'pi-morph-plugin' || manifest.name === 'pi-recurse') {
    const themeModule = await import(
      pathToFileURL(join(sdk.getPackageDir(), 'dist/modes/interactive/theme/theme.js')).href
    );
    const tuiPackage = findPackageJSON(
      '@earendil-works/pi-tui',
      pathToFileURL(join(sdk.getPackageDir(), 'package.json'))
    );
    const tuiManifest = JSON.parse(await readFile(tuiPackage, 'utf8'));
    const tui = await import(pathToFileURL(join(dirname(tuiPackage), tuiManifest.main)).href);
    const theme = themeModule.getThemeByName('dark');
    assert(theme);
    const args = {
      mode: 'single',
      prompt: 'Offline 漢字 café',
      target_filepath: '测试-é.ts',
      instructions: 'offline',
      search_term: 'offline',
      owner_repo: 'offline/repo',
    };
    for (const extension of owned)
      for (const { definition } of extension.tools.values()) {
        const context = { args, toolCallId: 'offline-render', cwd: home, isError: false };
        const components = [];
        if (definition.renderCall) components.push(definition.renderCall(args, theme, context));
        if (definition.renderResult)
          for (const expanded of [false, true])
            components.push(
              definition.renderResult(
                { content: [], details: undefined },
                { expanded, isPartial: true },
                theme,
                context
              )
            );
        for (const component of components)
          if (component) {
            for (const width of [24, 80])
              assert(component.render(width).every((line) => tui.visibleWidth(line) <= width));
            component.invalidate();
            renderers++;
          }
      }
  }
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
  assert.deepEqual(errors, []);
  session.dispose();
  assert.throws(() => api.getActiveTools(), /stale|inactive|invalid/i);
  await loadSession();
  assert(session.getActiveToolNames().includes('offline_native_probe'));
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      name: manifest.name,
      pi: VERSION,
      hostEntry,
      extensions: owned.length,
      tools: names.size,
      nestedRead: true,
      reload: true,
      renderers,
    })
  );
} finally {
  session?.dispose();
  globalThis.fetch = previousFetch;
  process.chdir(previousCwd);
  for (const key of environment)
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  delete globalThis[Symbol.for('pi1.workflow.identity')];
  await rm(home, { recursive: true, force: true });
}
