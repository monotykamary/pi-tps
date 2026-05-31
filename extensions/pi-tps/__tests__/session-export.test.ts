import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { unlinkSync, existsSync } from 'fs';
import { createTestFixture, activateExtension } from './helpers';

vi.mock('child_process', () => ({ execSync: vi.fn() }));

describe('pi-tps extension — session-export command', () => {
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
      type: 'message',
      role: 'user',
      content: 'hello',
      id: '2',
      parentId: '1',
      timestamp: '2026-01-01T00:00:01Z',
    },
    {
      type: 'model_change',
      provider: 'openai',
      modelId: 'gpt-4',
      id: '3',
      parentId: '2',
      timestamp: '2026-01-01T00:00:02Z',
    },
  ];

  const allEntries = [
    ...branchEntries,
    {
      type: 'custom',
      customType: 'tps',
      data: { tps: 20 },
      id: '4',
      parentId: '3',
      timestamp: '2026-01-01T00:00:03Z',
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'hi',
      id: '5',
      parentId: '4',
      timestamp: '2026-01-01T00:00:04Z',
    },
  ];

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
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

  it('should export all entry types from current branch by default', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(branchEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['session-export'].handler('', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 3 entries');
    expect(msg).toContain('pi-session-branch-');
    expect(msg).toContain('/pi-sessions/');
  });

  it('should export all entries from full session with --full flag', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getEntries: vi.fn().mockReturnValue(allEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['session-export'].handler('--full', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('Exported 5 entries');
    expect(msg).toContain('pi-session-full-');
  });

  it('should include all entry types — messages, custom, model_change', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(branchEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['session-export'].handler('', exportCtx);

    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    const filepath = msg.split('→ ')[1];
    const fs = await import('fs');
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content
      .trim()
      .split('\n')
      .map((l: string) => JSON.parse(l));

    const types = lines.map((l: any) => l.type);
    expect(types).toContain('custom');
    expect(types).toContain('message');
    expect(types).toContain('model_change');
    expect(lines).toHaveLength(3);
  });

  it('should preserve parentIds without re-chaining (full session export)', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getEntries: vi.fn().mockReturnValue(allEntries),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['session-export'].handler('--full', exportCtx);

    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    const filepath = msg.split('→ ')[1];
    const fs = await import('fs');
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = content
      .trim()
      .split('\n')
      .map((l: string) => JSON.parse(l));

    // Verify the parentId chain is preserved as-is
    expect(lines.find((l: any) => l.id === '1').parentId).toBeNull();
    expect(lines.find((l: any) => l.id === '2').parentId).toBe('1');
    expect(lines.find((l: any) => l.id === '3').parentId).toBe('2');
    expect(lines.find((l: any) => l.id === '4').parentId).toBe('3');
    expect(lines.find((l: any) => l.id === '5').parentId).toBe('4');
  });

  it('should show warning when no entries found', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([]),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['session-export'].handler('', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('No entries found');
    expect(msg).toContain('current-branch');
    expect(fixture.notifySpy).toHaveBeenCalledWith(msg, 'warning');
  });

  it('should show warning with --full when no entries found', async () => {
    const exportCtx = {
      ...fixture.mockCtx,
      sessionManager: {
        getEntries: vi.fn().mockReturnValue([]),
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
      },
    } as ExtensionCommandContext;

    await fixture.commands['session-export'].handler('--full', exportCtx);

    expect(fixture.notifySpy).toHaveBeenCalledOnce();
    const msg = fixture.notifySpy.mock.calls[0][0] as string;
    expect(msg).toContain('No entries found');
    expect(msg).toContain('all-entries');
  });
});
