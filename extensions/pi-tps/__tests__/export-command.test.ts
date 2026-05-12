import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { unlinkSync, existsSync } from 'fs';
import { createTestFixture, activateExtension, tick } from './helpers';

describe('pi-tps extension — export command', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  const branchEntries = [
    {
      type: 'custom',
      customType: 'tps',
      data: { tps: 10 },
      id: '1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00Z',
    },
    {
      type: 'custom',
      customType: 'neuralwatt-energy',
      data: { energy_joules: 100 },
      id: '2',
      parentId: null,
      timestamp: '2026-01-01T00:00:01Z',
    },
    { type: 'message', role: 'user', content: 'hello' },
  ];

  const allEntries = [
    ...branchEntries,
    {
      type: 'custom',
      customType: 'tps',
      data: { tps: 20 },
      id: '3',
      parentId: null,
      timestamp: '2026-01-01T00:00:02Z',
    },
  ];

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    // Clean up any pi-telemetry files written by the export handler
    for (const call of fixture.notifySpy.mock.calls) {
      const msg = call[0] as string;
      if (typeof msg === 'string' && msg.includes('→ ')) {
        const filepath = msg.split('→ ')[1];
        if (filepath && existsSync(filepath)) {
          try {
            unlinkSync(filepath);
          } catch {
            /* ignore */
          }
        }
      }
    }
    vi.restoreAllMocks();
  });

  it('should export current branch custom entries by default', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(branchEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['tps-export'].handler('', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 2 telemetry');
    expect(msg).toContain('pi-telemetry-branch-');
    expect(msg).toContain('/pi-telemetry/');
  });

  it('should export full session with --full flag', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getEntries: vi.fn().mockReturnValue(allEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['tps-export'].handler('--full', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 3 telemetry');
    expect(msg).toContain('pi-telemetry-full-');
  });

  it('should combine --full with customType filter', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getEntries: vi.fn().mockReturnValue(allEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['tps-export'].handler('tps --full', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 2 telemetry');
    expect(msg).toContain('pi-telemetry-full-tps-');
  });

  it('should filter branch by customType', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(branchEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['tps-export'].handler('tps', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 1 telemetry');
    expect(msg).toContain('pi-telemetry-branch-tps-');
  });

  it('should show warning when no matching entries found', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([{ type: 'message', role: 'user', content: 'hello' }]),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['tps-export'].handler('nonexistent', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('No matching entries found');
    expect(msg).toContain('current-branch');
    expect(fixture.notifySpy).toHaveBeenCalledWith(msg, 'warning');
  });

  it('should use exact customType match (neuralwatt-energy, not energy)', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([
          {
            type: 'custom',
            customType: 'neuralwatt-energy',
            data: { energy_joules: 100 },
            id: '1',
            parentId: null,
            timestamp: '2026-01-01T00:00:00Z',
          },
          {
            type: 'custom',
            customType: 'energy',
            data: { joules: 50 },
            id: '2',
            parentId: null,
            timestamp: '2026-01-01T00:00:01Z',
          },
        ]),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['tps-export'].handler('neuralwatt-energy', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 1 telemetry');
    expect(msg).toContain('pi-telemetry-branch-neuralwatt-energy-');
  });

  it('should include model_change entries and re-chain parentIds', async () => {
    const entriesWithModelChange = [
      {
        type: 'model_change',
        id: 'mc1',
        parentId: null,
        timestamp: '2026-01-01T00:00:00Z',
        provider: 'test',
        modelId: 'test-model',
      },
      {
        type: 'message',
        id: 'msg1',
        parentId: 'mc1',
        timestamp: '2026-01-01T00:00:01Z',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'custom',
        customType: 'tps',
        data: { tps: 10 },
        id: 'tps1',
        parentId: 'msg1',
        timestamp: '2026-01-01T00:00:02Z',
      },
      {
        type: 'message',
        id: 'msg2',
        parentId: 'tps1',
        timestamp: '2026-01-01T00:00:03Z',
        role: 'assistant',
        content: 'hi',
      },
      {
        type: 'model_change',
        id: 'mc2',
        parentId: 'msg2',
        timestamp: '2026-01-01T00:00:04Z',
        provider: 'other',
        modelId: 'other-model',
      },
      {
        type: 'custom',
        customType: 'tps',
        data: { tps: 20 },
        id: 'tps2',
        parentId: 'mc2',
        timestamp: '2026-01-01T00:00:05Z',
      },
    ];
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(entriesWithModelChange),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['tps-export'].handler('', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('2 telemetry + 2 structural');

    const filepath = msg.split('→ ')[1];
    const fs = await import('fs');
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content
      .trim()
      .split('\n')
      .map((l: string) => JSON.parse(l));

    expect(lines.find((l: any) => l.id === 'mc1').parentId).toBeNull();
    expect(lines.find((l: any) => l.id === 'tps1').parentId).toBe('mc1');
    expect(lines.find((l: any) => l.id === 'mc2').parentId).toBe('tps1');
    expect(lines.find((l: any) => l.id === 'tps2').parentId).toBe('mc2');
  });

  it('should include structural entries even with customType filter', async () => {
    const entriesWithModelChange = [
      {
        type: 'model_change',
        id: 'mc1',
        parentId: null,
        timestamp: '2026-01-01T00:00:00Z',
        provider: 'test',
        modelId: 'test-model',
      },
      {
        type: 'custom',
        customType: 'tps',
        data: { tps: 10 },
        id: 'tps1',
        parentId: 'mc1',
        timestamp: '2026-01-01T00:00:01Z',
      },
      {
        type: 'custom',
        customType: 'neuralwatt-energy',
        data: { energy_joules: 100 },
        id: 'ne1',
        parentId: 'tps1',
        timestamp: '2026-01-01T00:00:02Z',
      },
    ];
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(entriesWithModelChange),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['tps-export'].handler('tps', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('1 telemetry + 1 structural');
  });
});
