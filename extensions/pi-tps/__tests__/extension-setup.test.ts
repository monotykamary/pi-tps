import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestFixture, activateExtension } from './helpers';

describe('pi-tps extension — setup', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register all required event handlers and commands', () => {
    const { mockPi, registerCommandSpy } = fixture;

    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('session_tree', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('turn_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('message_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('message_update', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('message_end', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
    expect(registerCommandSpy).toHaveBeenCalledWith(
      'tps-export',
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      })
    );
  });
});
