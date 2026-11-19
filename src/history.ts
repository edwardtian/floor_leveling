/**
 * Undo/redo history: every command captures the full inverse (previous state)
 * and can be undone by applying the captured state back.
 * Snapshots vertex buffers (Float32Array copies) — meshes here are ≤ a few
 * hundred k vertices, so ~1-2 MB per step is fine.
 */
export type Command = {
  name: string;
  undo: () => void;
  redo: () => void;
};

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private limit = 64;

  push(cmd: Command): void {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): Command | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redoStack.push(cmd);
    return cmd;
  }

  redo(): Command | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.redo();
    this.undoStack.push(cmd);
    return cmd;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].name : null;
  }

  get redoLabel(): string | null {
    return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].name : null;
  }
}
